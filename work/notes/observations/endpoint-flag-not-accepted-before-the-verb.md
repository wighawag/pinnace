# `--endpoint` is only accepted AFTER the verb (unlike `--config`)

2026-07-26, spotted while documenting the config-less path for the READMEs.

`--config` is stripped globally (`takeConfigFlag` in `packages/pinnace/src/cli/run.ts`), so it may precede the command, but `--endpoint` is parsed per-verb: `pinnace --endpoint <url> status` exits 1 with `unknown command '--endpoint'`, while `pinnace status --endpoint <url>` works. Two flags that both look global behave differently, and the failure names the flag as a command rather than saying where it belongs.

**Resolved 2026-07-26 by the task `endpoint-flag-loud-and-global`.** `--endpoint` is now stripped globally too (`takeEndpointFlag`, run just before `takeConfigFlag`), so it is accepted on either side of the verb and both forms are the same invocation; giving it twice is a loud usage error rather than a silent pick, and a bare one is refused instead of being dropped (which used to widen the run back to every configured host). What the flag MEANS is unchanged. Build decisions: `work/notes/observations/endpoint-flag-loud-and-global-decisions.md`.
