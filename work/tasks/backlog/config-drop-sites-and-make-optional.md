---
title: Config shrink — drop `sites` from pinnace.json (rework its consumers) + make config optional
slug: config-drop-sites-and-make-optional
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: [deploy-pin-write-site-metadata]
covers: [1, 2]
needsAnswers: true
---

## What to build

Shrink `pinnace.json` to INFRASTRUCTURE only (hosts) and make it OPTIONAL. This is NOT a pure deletion: `cfg.sites` is READ by three live CLI call sites, which must be reworked, not just dropped.

- **Remove `SiteConfig` + `sites` from the config schema** (`PinnaceConfigFile`/`ResolvedConfig` keep `hosts`, `gateways`; lose `sites`).
- **Rework the three `cfg.sites` consumers:**
  1. `deploy` resolves `mode` from the matching site entry when `--mode` is absent (`cfg.sites.find(s => s.id === siteId)?.mode`). With `sites` gone, deploy's mode comes from `--mode` only (arg > a sensible default); the config-based mode fallback is REMOVED. (Metadata is the durable per-site mode home now — the deploy-writes-metadata task already persists it — but deploy at write-time takes it from `--mode`.) State the new mode-source order clearly and error/refuse sensibly if mode is unresolved, matching the current unresolved-mode error shape.
  2. `derive` normalises the id via `cfg.sites.find(s => s.id === siteId)?.id ?? siteId` -> becomes just `siteId` (the arg). Remove the `.find`.
  3. `promote` has the same `?? siteId` fallback -> becomes just `siteId`. Remove the `.find`.
- **Make the config file optional:** a publisher endpoint (+ token, env-only) supplied on the CLI yields a usable single-node target with NO `pinnace.json`. Add the CLI path (e.g. an existing/`--host-endpoint`-style flag or a dedicated `--endpoint`) so `deploy`/`pin`/`status`/`derive`/`promote` can operate against one node without a config file. A missing config file is already tolerated (benign empty) per the `--config` task; this task makes operating WITHOUT one actually work by sourcing the single host from the CLI.

Master + host tokens stay env-only (unchanged). The `--config <path>` behaviour (named-missing fails loud) is unchanged.

## Acceptance criteria

- [ ] `SiteConfig`/`sites` is removed from the `pinnace.json` schema; a `sites` key in a config fixture is ignored (no longer surfaced); `hosts`/`gateways` unchanged.
- [ ] The three `cfg.sites` consumers are reworked: deploy's mode = `--mode` (arg > default) with the config fallback gone and a clear unresolved-mode error; derive + promote use the `id` arg directly (no `.find`).
- [ ] The config file is OPTIONAL: with NO `pinnace.json`, a CLI publisher endpoint + env token yields a working single-node target for deploy/pin/status/derive/promote (a test proves at least one verb operates with no file, endpoint via CLI, token via env).
- [ ] Precedence otherwise unchanged (arg > env > file); master + tokens env-only; `--config` named-missing still fails loud.
- [ ] Test-first; env/config isolated (no real process.env / real pinnace.json read); no live daemon.

## Blocked by

- Blocked by `deploy-pin-write-site-metadata` (deploy must already source `mode` from `--mode`/write it to metadata before the config mode-fallback is removed, so ordering avoids a window where deploy has no mode source).

## Prompt

> Goal: make `pinnace.json` infra-only (hosts) and OPTIONAL, reworking the three live `cfg.sites` consumers. Read the spec `sites-metadata-in-mfs` (stories 1, 2; Impl Decisions "Config shrink is NOT purely additive" — it enumerates the consumers), the done tasks `config-resolution`, `cli-command-wrapper`, `cli-config-path-flag`, and the sibling `deploy-pin-write-site-metadata`.
>
> Remove `SiteConfig`/`sites` from the schema. Rework: (1) deploy's `mode` now comes from `--mode` (arg > default), the `cfg.sites.find(...)?.mode` fallback REMOVED, with a clear unresolved-mode error; (2) derive and (3) promote drop their `cfg.sites.find(...)?.id ?? siteId` to just `siteId`. Make the file optional: a CLI publisher endpoint + env token yields a single-node target with no `pinnace.json` (add the CLI endpoint path). Keep arg>env>file precedence, master/tokens env-only, `--config` named-missing loud. Test-first, env/config isolated, no live daemon. Done means config carries only hosts, is optional, and the three consumers work under the new model.

## Requeue 2026-07-25

Gate 2 (the PR/code review) failed to LAUNCH on the previous run — an infrastructure failure, not a code failure: the acceptance gate was fully green (format:check + build + 336 tests) on the rebased tip. The work on work/task-config-drop-sites-and-make-optional is believed complete. CONTINUE from that branch: re-verify the task's acceptance criteria against what is already there, change only what is actually missing or wrong, and do not redo work that already landed.

## Requeue 2026-07-26

GATE-2 BLOCK RESOLVED — HUMAN DECISION (supersedes the 'arg > a sensible default' wording in What to build above).

The block was correct: as landed, deploy's mode is '--mode > hardcoded ipfs' with NO metadata tier, so re-running 'pinnace deploy ./dist mysite' on a live ipns site silently runs in ipfs mode — deploy skips its own name/publish (the IPNS name keeps pointing at the OLD cid until the next on-box republish tick) AND metadata.mode is clobbered to ipfs. Meanwhile the sibling task preserves ensName with a careful read-modify-write. Fix the asymmetry: mode gets the SAME preserve treatment as ensName.

CONTINUE from the existing work/task-config-drop-sites-and-make-optional branch (its acceptance gate was fully green: format:check + build + 336 tests). Everything else on that branch — dropping SiteConfig/sites from the schema, the derive/promote .find removals, the optional-config CLI endpoint path — is GOOD and must be KEPT. Change ONLY the mode resolution described here.

1. MODE RESOLUTION becomes the spec's 'arg > metadata; no config entry', with a default only when nothing is stored:
   --set-mode <ipfs|ipns>  >  the site's STORED metadata.mode (read from MFS)  >  'ipfs'
   So a re-deploy with NO mode flag PRESERVES the site's stored mode and therefore still signs IPNS for an ipns site. A FIRST deploy (nothing stored) is 'ipfs'. Never silently demote.

2. RENAME THE FLAG to mirror the ens flags: '--mode' becomes '--set-mode' on BOTH deploy and pin. Omitting it = PRESERVE (exactly like omitting --set-ens-name). This is a deliberate BREAKING CLI rename; it is fine in 0.x and must be called out in the changeset.

3. NO '--unset-mode'. Unlike ensName, mode has no three-valued opt-out: there is no meaningful empty/absent state an operator would author, because an absent stored mode simply means 'ipfs'. Two states only: stated, or preserved.

4. A BARE '--set-mode' (no value) is a LOUD USAGE ERROR, not an infer. Bare --set-ens-name means 'infer the name from a .eth id'; mode has nothing to infer from, so bare must fail with a message naming the two valid values. Use the same ENS_NAME_BOOLEAN_FLAGS / optional-value parseArgs convention to DETECT the bare form, then reject it.

5. REUSE THE EXISTING SEAM. resolveSiteMetadataToWrite already does the ensName read-modify-write and already reads the stored metadata for the 'preserve' intent. Extend it so MODE flows through the same intent shape (a 'set' vs 'preserve' mode intent) and the preserve branch resolves BOTH fields from the ONE read it already performs — do not add a second read, and do not fork a parallel resolver. The JSDoc line 'The mode is always the one this operation runs in, never the stored one' is now WRONG and must be rewritten.

6. THE MULTI-NODE AMBIGUITY — resolve it explicitly, do not leave it implicit. Metadata is stored PER NODE, but 'does this deploy sign IPNS?' is ONE decision for the whole fan-out. Resolve the effective mode from the PUBLISHER target (the node that holds the key and actually signs), then write that ONE resolved mode into EVERY target's metadata.json, so nodes cannot diverge. If there is no publisher target, fall back to 'ipfs'. Record this in a decisions note under work/notes/observations/ (the sibling tasks each recorded one).

7. THE ACTUAL BUG FIX: deploy's own name/publish decision must follow the RESOLVED mode, not the raw flag — that is the regression that made this a block. Assert it in a test.

8. UPDATE the unresolved-mode error message and every usage string (deploy + PIN_USAGE) to the new flag and the new source order.

TESTS (test-first, at the mock Kubo seam, no live daemon) — add to what is already there:
  - re-deploy with NO mode flag on a site whose stored metadata says mode ipns -> stays ipns, metadata.json still says ipns, AND deploy performs its IPNS publish;
  - first deploy (no stored metadata, no flag) -> ipfs, no publish;
  - --set-mode ipns on a site stored as ipfs -> becomes ipns (an explicit flag always wins);
  - bare --set-mode -> loud usage error naming ipfs|ipns;
  - an invalid --set-mode value -> the loud unresolved-mode error;
  - pin's BOTH entry points (pin <cid> and pin --from-ipns) honour the same resolution;
  - the resolved mode is written identically to EVERY target in a multi-node fan-out.

The changeset must name the breaking '--mode' -> '--set-mode' rename AND the new arg > stored-metadata > ipfs order.
