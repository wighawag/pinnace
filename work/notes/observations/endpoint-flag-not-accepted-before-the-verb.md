# `--endpoint` is only accepted AFTER the verb (unlike `--config`)

2026-07-26, spotted while documenting the config-less path for the READMEs.

`--config` is stripped globally (`takeConfigFlag` in `packages/pinnace/src/cli/run.ts`), so it may precede the command, but `--endpoint` is parsed per-verb: `pinnace --endpoint <url> status` exits 1 with `unknown command '--endpoint'`, while `pinnace status --endpoint <url>` works. Two flags that both look global behave differently, and the failure names the flag as a command rather than saying where it belongs.
