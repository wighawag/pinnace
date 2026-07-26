---
title: review-gate non-blocking nits for 'endpoint-flag-loud-and-global' (Gate 2 approve)
date: 2026-07-26
status: open
reviewOf: endpoint-flag-loud-and-global
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'endpoint-flag-loud-and-global' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the general bare-flag SWEEP over a per-flag list: every parsed flag whose value is empty is refused, and any future flag whose bare form is meant to be meaningful must be registered in the OPTIONAL_VALUE_FLAGS exemption set. Note that set is keyed by flag NAME globally, not per verb, so a future verb reusing the name set-mode or set-ens-name inherits the exemption silently.
  (run.ts:1176 OPTIONAL_VALUE_FLAGS; run.ts:1203 refuseBareFlags; decisions note item 1. The task asked to fix the siblings sharing the defect and not redesign the parser; parseArgs is indeed untouched, so this stays inside the fence.)
- Ratify the new refusal for a bare UNKNOWN flag: pinnace status --oops now exits 1 with --oops needs a value, while pinnace status --oops x stays silently ignored. A script passing a harmless valueless unknown flag now fails where it used to succeed.
  (refuseBareFlags knows nothing of a verb's flag set (run.ts:1203); decisions note item 2 accepts the asymmetry and defers unknown-flag rejection to a future help/unknown-flag task.)
- Ratify the divergence between the two flags the README now both calls global: --endpoint refuses a REPEAT (even two identical values) while --config keeps its last-one-wins. Should a follow-up unify repeat semantics for all globals?
  (takeEndpointFlag repeat error (run.ts:~480) vs takeConfigFlag (run.ts:409, only the last --config wins); decisions note item 4; README line 209.)
- Coherence: --endpoint is stripped for EVERY command but consumed only by deploy/pin/status/site/promote, so pinnace node status --endpoint <url> and pinnace derive <id> --endpoint <url> accept it and do nothing with it. That is exactly the a-typed-flag-means-nothing shape this task set out to kill, and the README now presents the flag as global without naming which verbs actually consume it. Ratify the carve-out (and consider a doc line) or task the per-verb decision.
  (run.ts run() strips globally before dispatch; runNodeCli never reads rc.endpoint (run.ts:1353); decisions note item 6; packages/pinnace/README.md:209-211. Low real impact: node verbs are driven by systemd timers, and the on-box agent talks to its own daemon by design (ADR-0002).)
- Small hole in the never-mean-nothing guarantee introduced by stripping --endpoint first: a bare flag written immediately BEFORE --endpoint is no longer seen as bare, because the endpoint pair is removed and the flag then swallows a later positional. Example: pinnace deploy --gateways --endpoint <url> ./dist mysite parses gateways as ./dist and reports the deploy usage error instead of naming --gateways. Worth a note or a test rather than a fix.
  (takeEndpointFlag runs before parseArgs (run.ts:325, 455); all realistic shapes still exit 1 loudly (missing positional / expected a verb), so nothing succeeds wrongly; only the MESSAGE is misleading.)
- --config itself is not covered by the sweep and is not named in the changeset's list of fixed siblings: a trailing bare --config still resolves to an empty path and surfaces as failed to read config file '' rather than a --config needs a value message. Intentional (it is stripped before any verb parses), but it is the one remaining value-taking flag whose bare form does not get the new treatment.
  (takeConfigFlag sets configPath to '' for a bare flag (run.ts:409+), defaultLoadConfigFile('') throws ConfigLoadError (run.ts:238); .changeset/endpoint-flag-loud-and-global.md lists the swept flags and omits --config.)
