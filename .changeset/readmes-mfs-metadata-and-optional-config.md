---
'pinnace': patch
---

Docs: the package README (what npm shows) and the root README now describe the MFS-metadata model instead of the retired config-first one.

- `pinnace.json` is shown as INFRASTRUCTURE only (`hosts`, `gateways`) in every example; the `sites` array is gone.
- The config file is documented as OPTIONAL, with a worked `--endpoint <url>` example (one publisher node on the command line, token still env-only from `PINNACE_HOST_PUBLISHER_TOKEN`), plus the arg-tier note that `--endpoint` replaces the file's hosts while `--host-endpoint.<name>` overrides one declared host.
- Per-site `mode` and `ensName` are documented as MFS metadata written at deploy/pin time: `--set-mode ipfs|ipns` > the mode stored in the site's `metadata.json` > `ipfs` (omitting preserves; no `--unset-mode`), and the three ensName states (`--set-ens-name <name>`, bare `--set-ens-name` to restore inference, `--unset-ens-name` to opt out) plus omit-preserves and the `.eth`-id auto-inference. A new walkthrough step shows that changing a site's metadata is just a re-`deploy`.
- The MFS wrapper `/sites/<id>/{content,metadata.json}` is described in the mental model as what `status`, gateway warming and the on-box loop discover.
- The command reference matches the real CLI (`--set-mode`/ens flags on `deploy` + `pin`, and the `--endpoint`/`--gateways`/`--host-endpoint.<name>`/`--host-token.<name>` globals), and the package README's ADR link is absolute so it is not broken on npm. The post-install smoke test is now `pinnace version` (`pinnace --help` is not a command), and the `--endpoint` examples put the flag after the verb, where the CLI accepts it.
