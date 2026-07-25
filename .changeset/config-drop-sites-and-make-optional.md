---
'pinnace': minor
---

`pinnace.json` is now INFRASTRUCTURE only (`hosts`, `gateways`) and OPTIONAL.

- **The `sites` array is gone from the config schema** (`SiteConfig` is no longer exported). A site's identity and its per-site metadata (`mode`, `ensName`) live in the node's MFS wrapper `/sites/<id>/{content,metadata.json}`, written at deploy/pin time, so there is no site state in the config to keep in sync by hand. A stale `sites` key in an existing file is simply ignored, exactly as a stray `master`/`token` is.
- **`deploy`'s mode comes from `--mode` alone**, defaulting to `ipfs` (the same default `pin` has); the old "mode from the matching `pinnace.json` site entry" fallback is REMOVED. A `--mode` value that is neither `ipfs` nor `ipns` is a loud refusal naming the site. If you deploy an `ipns` site, pass `--mode ipns` (the emitted CI workflow already does).
- **`derive <id>` and `promote <id>` take the id from the argument verbatim** (there is no config entry to normalise it against); `derive` needs no config file at all.
- **NEW `--endpoint <url>`**: supplies ONE publisher node directly on the command line, so `deploy`/`pin`/`status`/`site`/`promote` work with NO `pinnace.json`. Its bearer token stays env-only under the usual convention (`PINNACE_HOST_PUBLISHER_TOKEN`), and a missing one is the same loud, named error. Being the arg tier it replaces the file's hosts for that run (arg > env > file); `--host-endpoint.<name>` still overrides the endpoint OF a configured host.

Precedence (arg > env > file), the env-only master + tokens, and the `--config <path>` behaviour (a named-but-missing file still fails loud) are unchanged.
