---
title: build decisions for 'endpoint-flag-loud-and-global' (a bare flag refuses; --endpoint goes global)
date: 2026-07-26
status: open
reviewOf: endpoint-flag-loud-and-global
---

# Making `--endpoint` loud and global: build decisions (2026-07-26)

Decisions recorded while building the task `endpoint-flag-loud-and-global` (a bare `--endpoint` becomes a usage error; the flag is accepted on either side of the verb). Captured here per the work contract because each one either sets a user-visible surface, introduces a new refusal, or touches another flag/verb/task.

Where this note is referenced from: the completion report links it, and the `refuseBareFlags` / `takeEndpointFlag` JSDoc in `packages/pinnace/src/cli/run.ts` carries the reasoning at the choice site.

## 1. The bare-flag refusal is a GENERAL sweep, not a per-flag list

The task named `--endpoint` and asked for an audit of its siblings. Rather than a table of "flags that must have a value" (which the next flag would have to be added to, and would silently miss), the CLI now sweeps EVERY parsed flag whose value is empty (`refuseBareFlags`, called right after `parseArgs` in each verb) and refuses the lot, naming each. So the rule is the policy sentence itself: a flag the operator typed must never mean nothing. Exemptions are an explicit two-name set (`OPTIONAL_VALUE_FLAGS`): `set-ens-name`, whose bare form legitimately means "infer from a `.eth` id", and `set-mode`, which owns a better, tailored refusal naming `ipfs|ipns`. Alternative considered and rejected: teaching `parseArgs` which flags are value-required and having it throw, which is the arg-parser redesign the task explicitly excluded. Touches: every verb (each gained one guard line), and any future flag, which is covered by default and must be added to the exemption set if its bare form is meant to mean something.

## 2. Consequence: a bare UNKNOWN flag now refuses too, while an unknown flag WITH a value is still ignored

The sweep cannot know which flags a verb actually understands, so `pinnace status --oops` (bare) now exits 1 with "`--oops` needs a value", while `pinnace status --oops x` stays silently ignored exactly as before. That asymmetry is deliberate: the CLI has never rejected unknown flags, and adding that is a separate surface decision, not this task. The refusal still surfaces the operator's typo by naming it, which is strictly better than the previous silence, so it is accepted rather than special-cased. Touches: any future "reject unknown flags / add a `--help`" task (see `work/notes/observations/cli-has-no-help-verb.md`), which should subsume this message.

## 3. Consequence: a bare REQUIRED flag now says "needs a value" instead of "missing required flag(s)"

`provision`/`install-ci` check their required flags with `missingFlags`, which reads a bare flag as absent. The sweep runs FIRST, so `pinnace provision --role` (bare) now reports "`--role` needs a value" rather than "missing required flag(s): --role". Both are loud and name the flag; the new one is truer (the operator DID type it), and putting the sweep first is what keeps one rule instead of two orders per verb. Touches: `provision` and `install-ci` error text only; no exit code changes.

## 4. `--endpoint` refuses a REPEAT, while `--config` still takes the last one

The task required that a value given in both positions refuse rather than be silently picked. Implemented as: any repetition of `--endpoint` refuses, including two IDENTICAL values (there is no reason to type it twice, and "identical is fine" is a rule an operator would have to learn). `--config`'s documented last-one-wins behaviour is deliberately left alone: changing it is a user-visible change to a different flag that this task did not ask for, and no caller was found relying on either behaviour. So the two global flags now differ on repeats, which is the one place they are not alike. Touches: `takeConfigFlag` and any future task that unifies the two globals (which should decide repeats once, for both).

## 5. `--endpoint` is stripped BEFORE `--config`, so the bare check judges what was typed

Both globals are stripped from the argv before the command is read. Order matters for the bare check: with `--config` stripped first, `pinnace --endpoint --config pinnace.json status` would arrive as `--endpoint status`, i.e. a bare endpoint reading a path-shaped token as its url and then reporting "no command given" (exit 0). Stripping `--endpoint` first makes that shape the loud refusal it is. The mirror case (`pinnace --config --endpoint <url> status`, a bare `--config`) stays as it was: `--config` swallows the following token as its path and fails loud naming it when the file cannot be read. Touches: `run()`'s global-flag order; any third global flag added later inherits this question.

## 6. The global flag is accepted, and ignored, by the verbs that touch no node

`--endpoint` is stripped for every command, but only the node-touching verbs consume it (`deploy`, `pin`, `status`, `site`, `promote`). So `pinnace node status --endpoint <url>` and `pinnace derive <id> --endpoint <url>` accept it and do nothing with it, exactly as `--config` has always been accepted-and-unused by `provision`/`derive`. This is the one remaining "means nothing" shape and it is knowingly left: the on-box `node` namespace talks to its own local daemon by design (ADR-0002), and refusing a global flag per-verb would need a per-verb table of which globals apply, which is the surface decision item 2 defers. Touches: the `node` namespace, `derive`, `provision`, `install-ci`; a future unknown-flag/help task should decide it for all globals at once.
