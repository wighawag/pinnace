# `--gateways` is parsed and resolved, but no client verb reads it

2026-07-27, spotted while enumerating every verb's real flag set for `reject-unknown-cli-flags`.

`cliOverridesFromFlags` reads `--gateways a,b` into `CliOverrides.gateways` and `resolveConfig` resolves it (arg > env `PINNACE_GATEWAYS` > file), but nothing in `packages/pinnace/src/cli/run.ts` ever reads `cfg.gateways`: the on-box loop gets its warm list from the box's `WARM_GATEWAYS` env instead. Separately, `ProvisionInput.gateways` exists (it is what ends up in `WARM_GATEWAYS` in the generated cloud-init) but `runProvision` never feeds it from a flag, so there is no CLI way to set a box's gateways at provision time either. The flag is allow-listed as-is by the new unknown-flag check (refusing a long-accepted flag is a separate surface decision); the open question is whether `--gateways` should reach `provision`, or be dropped.
