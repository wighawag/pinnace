---
'pinnace': patch
---

Refuse an unknown CLI flag instead of ignoring it: the rule "a flag you type must never mean nothing" now covers a flag's NAME, not just its value.

BEHAVIOUR CHANGE. Every verb declares the flags it accepts, and anything else is a loud error naming the offending flag, listing what that verb does accept, and exiting non-zero WITHOUT performing the operation. Anyone whose scripts pass a stale or misspelled flag will now see a refusal where the flag was previously parsed and silently dropped. That silence was a real, shipped failure: after the `--mode` -> `--set-mode` rename, `pinnace pin --from-ipns <src> --as ronan.eth --mode ipns` parsed, was read by nobody, pinned the site as `ipfs` with no IPNS record published, and stored `mode: ipfs`, which would have made the on-box `republish` skip the name until it lapsed. It was caught only because a human noticed a missing `ipns://` line; a CI or cron run would have failed silently. The same now catches plain typos (`--set-mod ipns`).

`--mode` gets an explicit RENAME HINT: on `deploy` and `pin` it refuses with "`--mode` was RENAMED: did you mean `--set-mode`?". The hint comes from a small static map of this project's renamed flags, and is only offered when the replacement is a flag that verb actually accepts.

Nothing valid is refused: the accepted set was enumerated per verb from the code (`provision`, `deploy`, `pin`, `status`, `derive`, `install-ci`, `site`, `authorize`, `node`, `version`), the PREFIX-shaped `--host-endpoint.<name>` / `--host-token.<name>` stay accepted on every node-touching verb (matched by prefix, for any host name), and the globals `--config` / `--endpoint` are stripped before the check so they are never reported as unknown from either side of the command. `authorize` keeps its own tailored `--host` refusal. Three verb surfaces tighten as a consequence: `deploy --host` (a deploy fans out to every node by design), and any flag on `node <verb>` or `version`, are now refusals rather than silent no-ops.

The bare-flag refusal is unchanged and composes with this one: the name check runs first, so a bare UNKNOWN flag now reports "unknown flag" rather than "needs a value", while a bare KNOWN flag still says "needs a value". `parseArgs` itself is untouched and no arg-parsing dependency was added.
