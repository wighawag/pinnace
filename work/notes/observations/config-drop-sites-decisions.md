---
title: build decisions for 'config-drop-sites-and-make-optional' (mode resolution + the --endpoint config-less path)
date: 2026-07-26
status: open
reviewOf: config-drop-sites-and-make-optional
---

# Config shrink (infra-only + optional): build decisions (2026-07-25)

Decisions recorded while building the task `config-drop-sites-and-make-optional` (remove `sites` from `pinnace.json`, rework its three consumers, make the file optional). Captured here per the work contract because each sets a USER-VISIBLE default/surface or touches another verb/flag/task, so a reviewer/human can ratify or reverse it.

Where this note is referenced from (so it is discoverable without trusting a claim): the `DEFAULT_DEPLOY_MODE` JSDoc in `packages/pinnace/src/cli/run.ts` names it by path, and the completion report links it.

## 1. SUPERSEDED (2026-07-26) — `deploy`'s new mode default is `ipfs`

SUPERSEDED by decision 4 below, by the human ruling that blocked the first review of this task. The CONSEQUENCE this entry flagged ("re-deploying an `ipns` site WITHOUT `--mode ipns` now runs as `ipfs`") was judged unacceptable rather than ratified: the mode now has a METADATA tier between the flag and the default, so omitting the flag PRESERVES. The entry is kept verbatim below because it records what was weighed, and the alternative it rejected (making the flag REQUIRED) is one of the alternatives decision 4 chose against.


The task's acceptance says deploy's mode is now `--mode` "arg > default" AND that an unresolved mode must stay a clear refusal. Implemented as: `mode = --mode ?? 'ipfs'`, with the loud refusal retained for a `--mode` value that is neither `ipfs` nor `ipns` (including a bare `--mode` with no value). So "unresolved" now means "invalid value", not "absent". `ipfs` was chosen because it is the conservative half of the pair (lands + pins + MFS, mints no name, signs nothing) and because `pin --mode` already defaults to `ipfs`, so the two carriers of the ONE `mode` concept default alike.

This REVERSES decision 3 of `work/notes/observations/cli-client-wrapper-decisions.md` ("if neither yields ipfs/ipns it ERRORS ... chosen over silently defaulting"), which was written when the config could still supply the mode; that note explicitly said a later default "should be decided jointly with the CI default". Noting the disagreement it leaves: the emitted GitHub workflow defaults its `SITE_MODE` var to `ipns` (`src/ci/ci-emit.ts`) — the two surfaces do not collide (CI always passes `--mode "$SITE_MODE"` explicitly), but they now default OPPOSITELY, which a reviewer should ratify or unify.

CONSEQUENCE to ratify (the real cost of a default here): re-deploying an `ipns` site WITHOUT `--mode ipns` now runs as `ipfs` — no record is signed this deploy AND `mode: "ipfs"` is written into that site's `metadata.json`, which the on-box republish loop honours, so the live name stops being refreshed. Alternative considered: make `--mode` REQUIRED for `deploy` (absent = the existing refusal), which removes that footgun entirely but contradicts the task's "arg > default" wording and breaks every current invocation that relied on the config entry. Touches: `deploy`, `pin`'s default, the `SITE_MODE` default in `ci-emitter-github`, the `mode` glossary entry (the backlog task `context-glossary-mfs-sites-metadata` must state "from `--mode`, default `ipfs`"), and the README task.

## 2. The config-less path is a new `--endpoint <url>` flag resolving to ONE host named `publisher`

Story 2 needs "a publisher endpoint + token on the CLI" to be a complete target with no file. Chosen shape: a new global-ish verb flag `--endpoint <url>` mapped onto a new `CliOverrides.endpoint`, which `resolveConfig` turns into a single `{name: 'publisher', endpoint, role: 'publisher'}` host. Consequences chosen deliberately:

- **The synthetic host is named `publisher`**, so its token comes from the EXISTING env convention (`PINNACE_HOST_PUBLISHER_TOKEN` via `hostTokenEnvVar`) with no special case, and its missing-token failure is the same loud, named error. The name is exported as `CLI_ENDPOINT_HOST_NAME`. Alternatives considered: `default`/`cli`/`node` (all would read oddly in the token env var), or a bespoke `PINNACE_TOKEN` for this path (a second token convention — rejected).
- **Its role is `publisher`**, because a single node must be able to sign its own names (a lone replica could publish nothing). There is no CLI way to declare the config-less node a replica; a replica setup is a multi-node setup, which is what the config file is for.
- **`--endpoint` REPLACES the file's hosts** rather than erroring when both are present, because it is the ARG tier of the documented `arg > env > file` precedence. Useful side effect: it narrows a multi-node config to one node for a single run. Alternative considered: refusing when a config also declares hosts (a new error, more surface, no gain).
- **Endpoint is arg-only** (no `PINNACE_ENDPOINT` env tier). Per-host endpoints already have their env tier (`PINNACE_HOST_<NAME>_ENDPOINT`), and inventing a second env spelling for the config-less node was more surface than the task asked for.

Coherence check: `--endpoint` does NOT re-mean the existing `--host-endpoint.<name>` (which overrides the endpoint OF a host the file declares, by name) nor `provision --publisher-endpoint` (where a replica fetches the publisher's record); the JSDoc on `CliOverrides.endpoint` states the distinction. Touches: every node-touching verb (`deploy`, `pin`, `status`, `site`, `promote`), the shared no-hosts refusal (which now names `--endpoint` first), and the README/glossary tasks that document the optional config.

## 3. `derive` no longer resolves the config at all


With the `cfg.sites.find(...)?.id ?? siteId` normalisation gone, `runDerive`'s `resolveConfig` call had no remaining consumer, so it was removed: `derive` is now a pure master + id computation that touches no config file and no node. Nothing user-visible changes (the `--config` flag is still accepted and still fails loud on a named-missing path, since that check happens in `run()` before dispatch). Touches: nothing else; recorded only because "derive reads the config" was previously true.

---

# The mode-resolution rework (2026-07-26)

The entries below implement the human ruling on the gate-2 block (recorded in the task body's "Requeue 2026-07-26"). They SUPERSEDE decision 1.

## 4. A site's mode is RESOLVED (`--set-mode` > stored metadata > `ipfs`), and the flag is RENAMED

`deploy`/`pin` no longer take a mode that is merely stated-or-defaulted. The order is now `--set-mode ipfs|ipns` > the mode STORED in the site's MFS `metadata.json` > `ipfs` (`DEFAULT_SITE_MODE`, in `packages/pinnace/src/site/site-wrapper.ts`). Omitting the flag is the PRESERVE intent, so a re-deploy of a published site keeps signing its record; only a site storing nothing runs as `ipfs`. `--mode` is RENAMED to `--set-mode` on both verbs to mirror `--set-ens-name`, whose omit-means-preserve semantics it now shares: a BREAKING CLI change, deliberate in 0.x, called out in the changeset.

Shape decisions inside that, each with what it touches:

- **No `--unset-mode`.** `ensName` is three-valued (a name / `""` opt-out / absent) so it needs one; `mode` has only two states because an absent stored mode already MEANS `ipfs` — there is no empty value an operator would author. Two states: stated, or preserved. Touches: the `mode` glossary entry (the backlog task `context-glossary-mfs-sites-metadata` must say `--set-mode` > stored metadata > `ipfs`, not "from `pinnace.json` or `--mode`"), and the README task `readmes-mfs-metadata-and-optional-config` (both READMEs still document `--mode`).
- **A BARE `--set-mode` is a loud usage error**, not an infer. A bare `--set-ens-name` means "infer the name from a `.eth` id"; a mode has nothing to infer from, so the bare form (detected by the same optional-value `parseArgs` convention) fails naming `ipfs|ipns`. Alternative considered: treating bare as "preserve" (i.e. a no-op), rejected because a flag the operator typed must never mean nothing.
- **The intent shape lives at the resolver, the INPUT stays an optional value.** `resolveSiteMetadataToWrite` takes a `SiteModeIntent` (`set` | `preserve`) alongside the `EnsNameIntent`, and its ONE existing read now answers BOTH preserve branches (no second round trip, no forked resolver). But `DeployInput.mode` / `PinExternalInput.mode` stay `mode?: SiteMode`, where OMITTED means preserve — for a two-state field an optional value expresses the intent exactly, and it keeps every existing library call site (and test) reading naturally. `siteModeIntent()` is the single place that maps one onto the other. Touches: `deploy`, `pin`, any library caller; `DeployInput.mode` became OPTIONAL (a caller that omits it now preserves instead of failing to compile).
- **`pin` derives its key eagerly when the mode is preserved.** Only the core knows the resolved mode (it reads the node), so the CLI cannot pre-check "does this pin need key material?". It therefore derives whenever a master is available (a local KDF, no node contact) and the core refuses loudly (`PinDerivedKeyRequiredError`) when a PRESERVED `ipns` entry has no key. A stated `--set-mode ipfs` derives nothing. Alternative considered: letting a keyless publisher skip the publish silently — rejected, that is the same silent-staleness bug in a new place. Touches: `pin`'s CLI pre-checks (the master/publisher refusals now guard the STATED ipns path; the preserved one is refused by the core).

## 5. The multi-node reading: the PUBLISHER decides, every node records the same answer

Metadata is stored PER NODE, but "does this deploy sign IPNS?" is ONE decision for the whole fan-out, so it cannot be taken per node. Both `deploy` and `pin` resolve the effective mode from the FIRST target whose role is `publisher` — the node that holds the key and actually signs — and then STATE that one resolved value into EVERY target's `metadata.json`, so nodes cannot diverge about how the site is addressed. A replica's stored mode never decides anything (a keyless node must not talk the fan-out into signing). The publisher's resolving read doubles as its own `ensName` read-modify-write, so it is read once, not twice.

With NO publisher among the targets the fallback is `ipfs`, as the ruling states. RESIDUAL to ratify: that fallback is a WRITE, so a replica-only fan-out (`pin --host <replica>`, or a config with no publisher at all) rewrites `mode: "ipfs"` into a replica's metadata that said `ipns`. Nothing signs in that situation either way, so no name goes stale; the alternative (falling back to PER-NODE preserve, which would leave each replica's own value alone) was rejected as a silent second resolution rule for a case the ruling settled explicitly. Touches: `pin --host`, and any future on-box loop that reads a replica's `metadata.mode`.

## 6. `ensName` preservation stays PER NODE (unchanged, stated because mode now differs)

The two metadata fields are now resolved differently and deliberately so: `mode` is ONE fan-out-wide decision (decision 5), while `ensName` remains resolved per node against that node's own stored metadata (a node that never had the site starts absent, whatever its siblings hold). The asymmetry is not an oversight: `ensName` is a per-node warming hint with no cross-node consequence, whereas the mode decides a single signing action. Recorded so a later reader does not "fix" one to match the other.
