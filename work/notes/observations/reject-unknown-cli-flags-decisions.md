---
title: build decisions for 'reject-unknown-cli-flags' (an unknown flag NAME is a refusal)
date: 2026-07-27
status: open
reviewOf: reject-unknown-cli-flags
---

# Refusing an unknown flag NAME: build decisions (2026-07-27)

Decisions recorded while building the task `reject-unknown-cli-flags` (a per-verb flag allow-list; an unknown flag is a loud refusal). Captured here per the work contract because each one either introduces a NEW refusal, sets a user-visible surface, or touches another flag/verb/task.

Where this note is referenced from: the completion report and the changeset link it, and the `refuseUnknownFlags` / `VERB_FLAGS` / `RENAMED_FLAGS` JSDoc in `packages/pinnace/src/cli/run.ts` carries the reasoning at the choice site.

## 1. The name check runs BEFORE the bare-value check, so a bare UNKNOWN flag changes its message

`refuseUnknownFlags` is called in each verb right after `parseArgs` and before `refuseBareFlags`. So `pinnace status --oops` now reports "unknown flag `--oops`" where it previously reported "`--oops` needs a value". This is exactly the subsumption item 2 of `endpoint-flag-loud-and-global-decisions.md` predicted and deferred to this task ("a future reject-unknown-flags task should subsume this message"). The alternative (bare check first) was rejected because it tells the operator to give a value to a flag that does not exist, which is a worse lie than the silence being fixed. For every flag a verb really has, `refuseBareFlags` behaves exactly as before. Touches: the bare-flag message for unknown flags only; no exit code changes (both are exit 1).

## 2. `deploy --host` becomes a refusal (it was silently ignored)

`deploy` fans out to EVERY configured node by design and has never read `--host`; the flag was parsed and dropped. It is deliberately NOT added to deploy's accepted set, so `pinnace deploy --host a ./dist mysite` now refuses. This is the same defect class the task exists to kill (a targeting instruction silently discarded, and a deploy that touched more nodes than the operator named), and it mirrors what `authorize` already does with `--host`, except that `authorize` owns a tailored message explaining its model. Alternative considered: accepting-and-ignoring it for compatibility, rejected because that IS the bug. Narrowing a deploy to one node remains `--endpoint <url>`. Touches: anyone scripting `deploy --host`, the README command table (unchanged, it never documented `deploy --host`).

## 3. `--gateways` stays ACCEPTED on the five config-resolving verbs, though no client verb consumes it

`cliOverridesFromFlags` reads `--gateways` into `CliOverrides.gateways`, and `resolveConfig` resolves it, but no client verb reads `cfg.gateways` (the on-box loop gets its gateway list from the box's `WARM_GATEWAYS` env instead). So the flag is a real, parsed, documented-in-the-CHANGELOG flag whose resolved value currently reaches nobody. It is allow-listed on `deploy`/`pin`/`status`/`site`/`authorize` rather than refused, because refusing a flag that has always been accepted is a separate surface decision and the task's own bar is that wrongly refusing a valid command is worse than the bug being fixed. Whether `--gateways` should DO something (or be dropped) is captured separately in `work/notes/observations/cli-gateways-flag-reaches-nobody.md`. Touches: that note, and any future task that wires or removes the flag (which should also update `VERB_FLAGS`).

## 4. `node <verb>` and `version` accept NO flags, so any flag there is now refused

Neither surface has ever read a verb flag: the on-box `node` verbs take everything from the box env (`/etc/pinnace-node.env`, ADR-0002), and `version` prints a string. Both now refuse a typed flag (`pinnace node warm --gateways x`, `pinnace version --json`) instead of ignoring it. The globals are unaffected on both, since `--config`/`--endpoint` are stripped before any verb is dispatched: item 6 of `endpoint-flag-loud-and-global-decisions.md` (a global accepted-and-ignored by a verb that touches no node) is therefore deliberately LEFT standing, not reversed here, because that is a property of the globals, not of an unknown name. Verified that the generated cloud-init invokes `pinnace node <verb>` with no flags, so no provisioned box breaks. Touches: the `node` namespace, `version`, and the deferred question in that earlier note.

## 5. A rename hint is only offered when the replacement is accepted BY THAT VERB

`RENAMED_FLAGS` is a static map (currently exactly one entry, `mode` -> `set-mode`, the rename in the current release train). The hint is emitted only when the replacement is in that verb's accepted set, so `pinnace status --mode ipns` is refused without being told to type `--set-mode`, which `status` does not have either. Alternative considered: a generic nearest-match (Levenshtein) suggestion, deliberately not built. The task calls it optional and secondary, and a fuzzy suggestion can confidently point at the WRONG flag, which is the failure mode this whole change exists to prevent. Touches: any future flag rename, which must add one line to `RENAMED_FLAGS`.

## 6. The allow-list is a hand-maintained TABLE, not derived from the parsers

`VERB_FLAGS` enumerates each verb's flags by hand, next to a one-line reason. It cannot be derived, because a verb reads its flags ad hoc (`flags['host-token.a']` is read by prefix, `--set-ens-name` by an intent helper), and deriving it would mean the `parseArgs` redesign the task explicitly excluded. The cost is real: a flag added to a verb without a table entry becomes a FALSE refusal of a valid command. That is mitigated by (a) the JSDoc on `VERB_FLAGS` saying so at the choice site, and (b) `test/cli/unknown-flag.test.ts`, which runs a full valid command line per verb using every flag that verb accepts, so an omission fails the suite rather than reaching an operator. Touches: every future CLI flag.
