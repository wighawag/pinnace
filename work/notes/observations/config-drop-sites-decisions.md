---
title: build decisions for 'config-drop-sites-and-make-optional' (deploy mode default + the --endpoint config-less path)
date: 2026-07-25
status: open
reviewOf: config-drop-sites-and-make-optional
---

# Config shrink (infra-only + optional): build decisions (2026-07-25)

Decisions recorded while building the task `config-drop-sites-and-make-optional` (remove `sites` from `pinnace.json`, rework its three consumers, make the file optional). Captured here per the work contract because each sets a USER-VISIBLE default/surface or touches another verb/flag/task, so a reviewer/human can ratify or reverse it.

Where this note is referenced from (so it is discoverable without trusting a claim): the `DEFAULT_DEPLOY_MODE` JSDoc in `packages/pinnace/src/cli/run.ts` names it by path, and the completion report links it.

## 1. `deploy`'s new mode default is `ipfs` (this REVERSES the earlier no-default decision)

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
