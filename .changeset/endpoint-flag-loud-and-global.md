---
'pinnace': patch
---

Make `--endpoint` behave like the global, honest flag it reads as.

It is now accepted on EITHER side of the command, exactly like `--config`: `pinnace --endpoint <url> status` and `pinnace status --endpoint <url>` are the same invocation (the leading form used to exit 1 with a misleading `unknown command '--endpoint'`). It is stripped globally before the verb parses anything, so nothing about what it MEANS changed: still the arg tier of the resolution (arg > env > file), still replacing the file's hosts for that run, with `--host-endpoint.<name>` still overriding the endpoint OF a configured host. Given more than once it is a loud usage error naming both values, rather than a silent pick.

A BARE `--endpoint` is now refused. Previously it parsed as an empty value and was dropped, so `pinnace deploy --endpoint --set-mode ipns ./dist mysite` discarded the operator's targeting instruction and deployed to EVERY host in `pinnace.json`: the worst shape of failure, a narrowing instruction silently widened. All three bare shapes (end of the line, immediately followed by another `--flag`, an explicit empty value) now fail loud naming the flag and its form, in either position.

The same swallowed-bare-form defect is fixed on every sibling flag, generalising the rule the bare `--set-mode` refusal established: a flag the operator typed must never mean nothing. Any value-taking flag written with no value is now a usage error naming it, so these no longer silently revert to the default they were meant to override: `--host` (a bare one widened a `pin` to every node, and let `site`/`promote` auto-pick), `--gateways`, `--host-endpoint.<name>`, `--host-token.<name>` (which used to override with `''`), `--from-ipns`, and the optional flags of `provision` (`--dashboard-domain`, `--publisher-endpoint`, `--kubo-version`, `--pinnace-version`, `--node-major`) and `install-ci` (`--branch`, `--node-version`). Two flags are deliberately exempt, keeping their existing meaning: `--set-ens-name` (bare = infer from a `.eth` id) and `--set-mode` (which owns a tailored refusal naming `ipfs|ipns`). The arg parser itself is unchanged.
