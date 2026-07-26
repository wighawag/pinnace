# `gateways` (config key + `--gateways`) is resolved but nothing consumes it

2026-07-26, spotted while deciding what to show in the README's `pinnace.json` sample.

`resolveConfig` produces `gateways` (from `--gateways` / `PINNACE_GATEWAYS` / the file), but no client verb reads `cfg.gateways`: the warm list the box actually uses comes from `WARM_GATEWAYS` in `/etc/pinnace-node.env`, baked by `provision`, and the `provision` CLI exposes no `--gateways` flag (only the library `ProvisionInput.gateways`), so the box always gets `DEFAULT_GATEWAYS`. The READMEs therefore document only `hosts`.
