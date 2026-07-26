---
title: Replace promote with authorize — publisher-targeted, idempotent, no fake role flip
slug: authorize-replaces-promote
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: []
covers: [4]
---

## What to build

`promote` is misnamed, mis-scoped, and partly a lie. Replace it with `authorize`.

**Its real, primary job** is the master-free CI bootstrap: run it ONCE from the operator's machine (which holds `PINNACE_MASTER`) so the publisher's keystore holds the site key, after which CI deploys forever WITHOUT the master. `deploy` now auto-imports the key when it has the master, but that only bootstraps if you deploy locally at least once, and a CI-only setup never does. So this verb stays first-class; it is just not "promotion".

**The lie to delete.** `promoteReplicaToPublisher` returns a literal `{role: 'publisher', ...}` and its doc says "Flip the role. From here the node is the single signer". Nothing is persisted. A node's role really lives in TWO places, neither of which this touches: `pinnace.json` `hosts[].role` (the client's view, hand-edited) and `NODE_ROLE` in the box's cloud-init env file (what the box's own timers self-gate on). The `currentRole` field on `PromoteReplicaInput` is DEAD (declared, never read in the function body). So the verb grants key MATERIAL and nothing else, and must say so.

### The new verb

```
pinnace authorize            # every site the publisher holds
pinnace authorize <id>       # just that site
```

- **No `--host`.** The config already declares who the publisher is; the flag only restated it. Resolve the target from the config's declared `role: publisher` host. This also removes the `pickHost` friction where `--host` becomes mandatory as soon as a second host exists.
- **Bare form = every site.** Discover the publisher's sites from MFS (`/sites/*`, the existing `discoverSites`) and authorize each. `authorize <id>` does exactly one, and does NOT require the site to exist in MFS yet (a key can be pre-authorized before the first deploy, which is the CI-bootstrap case).
- **Idempotent.** Probe `key/list` FIRST. A key already held is a clean no-op reported as such (not an error, not a re-import). Only a genuinely absent key is imported. Re-running the whole bare form must be safe and must report per-site what it did (`authorized` vs `already-authorized`).
- **Needs the master.** Derive via the existing `deriveIpnsKey` from the env-only `PINNACE_MASTER` + the site `id`. A missing master is the usual loud, named refusal.

### Guards

1. Config declares **zero** publishers -> refuse loudly (there is nothing to authorize).
2. Config declares **more than one** publisher -> refuse loudly. The model is exactly one publisher per shared IPNS name; picking one silently would be a coin flip.
3. **Another configured host already holds a key for this site** -> refuse. Importing would create a SECOND signer, and two boxes signing one name race IPNS sequence numbers. Check the other hosts' keystores over `key/list` before importing. This guard is only possible when the config can see the fleet; skip it (documented) under `--endpoint`.
4. `importIpnsKeyIntoPublisher`'s existing refusal to import onto a `replica` role STAYS. Do not weaken it.

### `--endpoint` is an ASSERTION, and must be documented as one

`--endpoint` must work (the config file is optional, and that is a first-class path). But it MINTS a synthetic host named `CLI_ENDPOINT_HOST_NAME = 'publisher'` with role `publisher`, so guard 1/2/4 can never fire on that path: the client invents the role it then checks. The box's REAL role (`NODE_ROLE`) is not exposed over Kubo RPC, so it cannot be cross-checked either. Do NOT pretend otherwise, and do not fake a check. Document the `--endpoint` form as the operator ASSERTING that this node is the publisher, unverifiable by pinnace, exactly as `deploy --endpoint` already works. Guard 3 is also impossible there (one box is visible); say so.

## Acceptance criteria

- [ ] `pinnace promote` is GONE and `pinnace authorize` replaces it (hard rename, no alias); `--host` is no longer accepted by it. The core function and its input/result types are renamed to match (no `promoteReplicaToPublisher`, no `PromoteReplicaInput/Result`), and `src/index.ts` exports the new names.
- [ ] The fake role flip is deleted: nothing returns a synthesised `role: 'publisher'`, and the dead `currentRole` input is removed. The result reports what actually happened (the key name, its ipns id, and whether it was imported or already held).
- [ ] `authorize <id>` imports the derived key onto the config's declared publisher and reports `authorized`; run again it reports `already-authorized` and issues NO `key/import` (tested against the mock).
- [ ] Bare `authorize` discovers the publisher's sites from MFS and authorizes each, reporting per-site `authorized` / `already-authorized` (tested, including a mix).
- [ ] `authorize <id>` works for a site that does NOT yet exist in MFS (the pre-deploy CI-bootstrap case).
- [ ] Zero declared publishers refuses loudly; more than one declared publisher refuses loudly (tested both).
- [ ] When another configured host already holds a key for the site, the import is REFUSED with an error naming that host and the two-signer hazard (tested).
- [ ] A missing `PINNACE_MASTER` is the usual loud refusal naming the env var (tested).
- [ ] `--endpoint <url>` is accepted and authorizes that node; the fleet-wide guard is documented as skipped there. The replica-role refusal in `importIpnsKeyIntoPublisher` is unchanged (tested: a declared replica is still refused).
- [ ] The package README + CONTEXT.md glossary are corrected: `authorize`'s PRIMARY use is the master-free CI bootstrap (run once locally, CI deploys need no master); FAILOVER is currently a REPROVISION, stated plainly, because a promoted box's `NODE_ROLE` and every other replica's `PUBLISHER_ENDPOINT` are cloud-init env values unreachable over Kubo RPC. Do not describe `authorize` as changing any role. Any remaining "promote" references (README table, walkthrough, deploy's refusal message naming `pinnace promote`, glossary) are updated.
- [ ] Test-first, at the mock Kubo seam; env/config isolated; no live daemon. A changeset is included, calling out the breaking rename and the dropped `--host`.

## Blocked by

- None.

## Prompt

> Goal: replace the misnamed, partly-fictional `promote` with an honest `authorize`. Read `src/publisher/record-sequence.ts` (`promoteReplicaToPublisher` and its dead `currentRole`), `src/publisher/key-import.ts` (`importIpnsKeyIntoPublisher`, which refuses a replica), `src/cli/run.ts` (`runPromote`, `pickHost`, and how `runDeploy` derives from the master), `src/config/config-resolution.ts` (`CLI_ENDPOINT_HOST_NAME`, the synthetic publisher `--endpoint` mints), and ADR-0003.
>
> The verb's real job is the master-free CI bootstrap: authorize once locally, then CI deploys need no master forever. It grants key MATERIAL only. Today it also pretends to flip a role by returning a hard-coded string while persisting nothing, and carries a `currentRole` input that is never read. Delete both.
>
> Make it `authorize`, targeting the config's declared publisher (no `--host`), idempotent via a `key/list` probe, bare form covering every site discovered in MFS. Refuse on zero or multiple declared publishers, and refuse when another configured host already holds the key (that would create a second signer racing IPNS sequence numbers). Accept `--endpoint` but be honest in the docs that it MINTS the publisher role, so the role guard cannot fire there.
>
> Done means: the verb does exactly what it says, re-running it is safe, and nobody reading the docs believes it performs a failover.
