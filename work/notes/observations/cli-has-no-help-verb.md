# The CLI has no `--help` / `help`

2026-07-26, spotted while verifying every README command against the real CLI.

`pinnace --help` exits 1 with `unknown command '--help'` (`run()` in `packages/pinnace/src/cli/run.ts` handles `version`/`--version`/`-v` and the verbs, nothing else), so the install smoke-test both READMEs used was wrong; they now say `pinnace version`. A real `--help` listing the verbs would be the natural first command after install.
