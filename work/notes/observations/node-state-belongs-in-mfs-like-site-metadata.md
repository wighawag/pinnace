# Node state (`NODE_ROLE`, `PUBLISHER_ENDPOINT`) belongs in MFS, like site metadata

2026-07-26, surfaced while renaming `promote` to `authorize`.

The `sites-metadata-in-mfs` spec moved PER-SITE state out of the client's config and into MFS, because the box can only act on what it can SEE, and what it can see is MFS over its bearer-guarded Kubo RPC. **Per-NODE state has the identical problem, one level up, and it is still stuck in a boot-time env file.**

Two values are written into the box's cloud-init env file at first boot and are unreachable over Kubo RPC afterwards:

- **`NODE_ROLE`** gates which on-box timers do anything (`republish` only on a publisher, `mirror` only on a replica; the verbs self-gate on it).
- **`PUBLISHER_ENDPOINT`** tells a replica where to fetch the publisher's exported signed records.

## The three symptoms this causes

1. **Failover is a REPROVISION, not an operation.** Moving the keys to a surviving replica is pure RPC and easy, but the new publisher will never sign, because its `NODE_ROLE` still says `replica`. And every OTHER replica keeps mirroring the dead box, because their `PUBLISHER_ENDPOINT` still points at it. Both need SSH or a rebuild. This is why the old `promote` verb degenerated into importing a key and returning a synthesised `role: 'publisher'` string that persisted nothing: the honest operation was not reachable.
2. **The replica guard cannot be enforced under `--endpoint`.** `--endpoint` mints a synthetic host with `role: 'publisher'`, so the client invents the role it then checks, and the box's real role is invisible. `authorize --endpoint <url>` at a machine that is actually a replica will import a key onto a box that must never hold one, and nothing can detect it. With the role in MFS, the guard becomes real on BOTH paths.
3. **The two-signer hazard is only half-detectable.** With a config, `authorize` can check the other hosts' keystores before importing. Under `--endpoint` only one box is visible, so nothing catches a second signer racing IPNS sequence numbers.

## The shape of the fix

Store node state in MFS (`filesWrite`/`filesRead` already exist, added by `kubo-client-files-read-write`) rather than the env file, and have the on-box verbs read it from there. Then:

- a box's role is CLIENT-CHANGEABLE over the same bearer-guarded RPC everything else uses;
- `authorize` can verify the target's ACTUAL role and refuse a replica for real;
- failover becomes a genuine client-driven operation, roughly: attempt `key/rm` on the old publisher (best-effort, it is usually down, which is why you are failing over), rewrite the role + publisher-endpoint state on the affected boxes, update `pinnace.json` to match, then `authorize`. Note `key/rm` is NOT wrapped on `KuboRpcClient` today (it has `key/list` + `key/import` only), so that is a prerequisite.

## The residual hazard that this does NOT fix

If the old publisher was unreachable when its keys were removed and it later comes back holding them, two boxes sign the same name and race sequence numbers. Best-effort removal cannot close that; only taking the old box out of service can. Any failover design must say so rather than imply the split-brain is handled.

Not tasked. This is a spec seed (it touches ADR-0002's on-box boundary and the provisioning contract), not a change to make inside a rename.

## Update 2026-07-30: reviewed against doing nothing; verdict: do NOT build this yet

The idea above was reviewed against the status quo (recover a name by REPROVISIONING a box to sign). Outcome: the case is materially weaker than this note argues, and something else should go first. Recorded here rather than rewriting the note, per the append-only rule.

**Symptom 1 is half wrong: DNS already is the indirection layer.** This note says the other replicas "keep mirroring the dead box, because their `PUBLISHER_ENDPOINT` still points at it", and that they need SSH or a rebuild. They do not. `PUBLISHER_ENDPOINT` is a URL against the publisher's DASHBOARD DOMAIN, not an IP: `record-sequence.ts` uses it only as a base for `/records/<id>.ipns-record`, and the live run in `notes/findings/live-end-to-end-validated-clean-boot-onbox-failover.md` shows replicas fetching `https://ipfs-dash.ska.sh/records/basic.ipns-record`. Repointing that ONE DNS record moves every replica to a new publisher at once, with no SSH, no rebuild, and no pinnace change. So the do-nothing failover is: provision a new publisher box with the SAME `--dashboard-domain`, repoint DNS, `deploy` (or `pin`, fetching from the surviving replicas), `authorize`. What remains genuinely stuck is only a SURVIVING replica's own `NODE_ROLE`, and promoting one is the wrong move anyway, since cloud-init runs only at first boot, so "reprovision the replica" means destroying the one box that already holds all the content. (Precondition worth stating in any runbook: this works only when `PUBLISHER_ENDPOINT` is a domain the operator controls, not a bare IP.)

**The window is ~72h, not an emergency.** `RECORD_LIFETIME` is 72h, republish every 6h, mirror every 3h. Content stays fully reachable from every replica throughout. The do-nothing path costs perhaps 20-40 minutes of operator time inside a 3-day window, on an event that for a 1-2 box fleet approximately never happens.

**Symptom 2 is the real prize, and it is not about failover.** Making `authorize --endpoint` able to see a box's ACTUAL role is worth having on its own. But it is an interlock against OPERATOR ERROR, not a security boundary: anyone holding the bearer token who can flip the role in MFS can equally just `key/import` directly. Worth scoping as its own small piece if this is ever revived; not worth a spec on its own terms.

**Two costs this note does not count.** (a) Role would then live in THREE places, not one: `pinnace.json` `hosts[].role`, the box's `NODE_ROLE`, and MFS. `NODE_ROLE` cannot simply be deleted without answering "what role is a box before anyone writes MFS state?", so the change ADDS a bootstrap default and a precedence rule rather than removing state. (b) There is no safe READ failure. The repo convention says a check that could not run never reports a definitive negative, but if node state is unreadable, defaulting to `replica` SILENTLY STOPS SIGNING (the name dies at 72h) and defaulting to `publisher` risks two signers. Site metadata dodged this with tolerant-for-read / strict-for-write; role has no analogous safe read. That is an unsolved design point, not a detail.

**What dominates both options.** A verified hazard in the failover PRIMITIVE itself, now captured as `notes/findings/ipns-sequence-resets-to-zero-on-a-new-signer.md`: when a new signer's DHT lookup for the existing record fails, boxo silently resets the IPNS sequence to 0, so the new record LOSES to the dead publisher's for the rest of the 72h validity, with every pinnace indicator green. This applies identically to the reprovision path and to any future in-place role change, so it is not a tiebreaker between them. It is evidence that the binding constraint on failover is CORRECTNESS, not ergonomics. Building the MFS layer first would ship a fast, confident one-command failover that can silently not take effect.

**Recommended order instead:** (1) the finding above, captured; (2) write the failover RUNBOOK for the do-nothing path (new publisher box, same dashboard domain, DNS repoint, deploy, authorize): cost is one doc, and it absorbs most of the pain this note targets, while correcting the README, which says recovery means "reprovisioning a box to sign" without mentioning that the DNS indirection makes every replica follow for free; (3) wrap the `sequence` param on `namePublish` and surface a name's current sequence in `status`, if (1) proves to bite in practice; (4) revisit node-state-in-MFS only if failover frequency ever justifies it, scoped then to the `authorize` replica guard.

This note stays LIVE as a signal (the underlying observation about per-node state being unreachable is still true and still unaddressed); it is just not the next thing to build.
