---
title: build decisions for 'deploy-pin-write-site-metadata' (--set-ens-name / --unset-ens-name)
date: 2026-07-25
status: open
reviewOf: deploy-pin-write-site-metadata
---

# `deploy`/`pin` write the site metadata: build decisions (2026-07-25)

Decisions recorded while building the task `deploy-pin-write-site-metadata` (deploy + pin write `{ensName?, mode}` into the MFS wrapper's `metadata.json`, with two ensName verb-flags). Captured here per the work contract because each one either introduces a named concept, touches another verb/flag/task, or sets a user-visible surface, so a reviewer/human can ratify or reverse it.

Where this note is referenced from (so it is discoverable without trusting a claim): the `src/site/site-wrapper.ts` module JSDoc names it by path, and the completion report links it.

## 1. NEW named concept: `EnsNameIntent` (the write-side counterpart of the three-valued `ensName`)

The stored `ensName` FIELD is three-valued (a name / `""` / absent) and `CONTEXT.md` already defines `ensName` as the eth.limo warming hint. What an OPERATION says about that field is a FOURTH thing (`preserve` — say nothing, leave it alone), which cannot be represented as a value, so a new type carries it: `EnsNameIntent = {kind:'set',name} | {kind:'infer'} | {kind:'unset'} | {kind:'preserve'}` (`src/site/site-wrapper.ts`), resolved to real metadata by `resolveSiteMetadataToWrite`. Coherence check: it does NOT re-mean `ensName` (the field keeps its three values, unchanged, so the on-box warm rule keeps its three-way resolution) and it does not duplicate `mode` (which is required per operation and so needs no preserve case). Alternatives considered: (a) `ensName?: string` on `DeployInput`/`PinExternalInput` — cannot distinguish "leave alone" from "set to absent", the exact distinction the task is about; (b) two booleans plus a string — the same states, unrepresentable-illegal-states lost. Touches: the `ensName` glossary entry (the backlog task `context-glossary-mfs-sites-metadata` should mention the intent flags), `DeployInput`, `PinExternalInput`, and the on-box warm task (which reads the FIELD, not the intent).

## 2. Bare `--set-ens-name` and `--set-ens-name ""` are the SAME thing (infer), by the existing parseArgs convention

The task fixed the optional-value detection on the existing `parseArgs` no-value convention: a flag at end-of-argv or immediately followed by another `--flag` parses as an empty value. That convention cannot distinguish a bare flag from an explicitly-empty value, so `--set-ens-name ""` is read as BARE (infer), NOT as the `""` opt-out. This is why the opt-out has its own verb-flag (`--unset-ens-name`): no single flag has to mean two things. Alternative considered: special-casing a quoted empty string in `parseArgs` (it would have to record "flag seen with a value that was empty" as distinct from "flag seen with no value"), rejected as re-meaning the shared parser for one flag. Touches: `parseArgs` (unchanged), every other value-taking flag, the `pin`/`deploy` usage strings.

## 3. `preserve` reads per NODE, and the operation's `mode` always wins

The read-modify-write happens per target, against THAT node's `/sites/<id>/metadata.json`, because metadata travels with the site on each node (spec `sites-metadata-in-mfs`); a node that never held the site starts absent whatever its siblings hold, so a partially-deployed fleet converges rather than one node's value being copied everywhere. The `mode` written is always the mode this operation ran in, never the stored one (the operator's `--mode` is what they just asked for). Consequence to ratify: every no-flag `deploy`/`pin` now costs ONE extra `files/read` per node (skipped for the three total intents, which fully determine the field). Alternative considered: read once on the first target and write that everywhere, rejected as inventing a fleet-wide truth the MFS layout deliberately does not have. Touches: the on-box loop's view of per-node metadata, the deploy/pin call-sequence tests.

## 4. The `.eth` guard is checked TWICE: in the CLI (pre-check) and in the core (repeat)

`assertEnsNameIntent` runs in the CLI before hosts/tokens are resolved (so the message names what the operator typed and nothing is dispatched) AND at the top of `deploy`/`pinExternal` (so library callers get the same refusal before any node is touched). This mirrors the existing `PinPublisherRequiredError` pattern (CLI refusal + core repeat) rather than inventing a second stance. Touches: `src/cli/run.ts` (deploy + pin), `src/deploy/deploy.ts`, `src/pin/pin-external.ts`.

## 5. `deploy`'s mode SOURCE is unchanged here (`--mode` > the `pinnace.json` site entry)

The task's acceptance says deploy's mode is "`--mode` (arg > default)" because the config mode-source "is going away" — but removing `cfg.sites.find(...)?.mode` (and choosing what the new default/refusal is) is explicitly the job of the backlog task `config-drop-sites-and-make-optional`, which is `blockedBy` THIS task precisely so deploy never has a window with no mode source. So this build leaves deploy's resolution exactly as it was and only PERSISTS the resolved mode into `metadata.json`. Touches: `config-drop-sites-and-make-optional` (it must still remove the fallback and state the new order); nothing user-visible changed here.

## 6. `site add` still writes `{mode:'ipfs'}` with NO preserve

`addSite` was left untouched: it has no mode surface and no ens flags, so re-`add`ing over an existing site still overwrites its metadata (dropping an `ensName`, and — once the on-box loop reads `mode` — demoting an ipns site). That consequence was already recorded by the previous task and re-raised as an open review nit (`review-nits-mfs-site-wrapper-layout-and-metadata-seam-2026-07-25.md`); extending the preserve semantics to `add` is a separate decision about `add`'s surface, not part of this task. Touches: the open nit, `src/site/site-management.ts`.
