---
'pinnace': minor
---

Release as a MINOR: an unknown flag is now a REFUSAL, which changes behaviour for any script passing a stale flag.

- **Unknown flag names are rejected.** Previously `parseArgs` accepted any `--token` and stored it, so a flag no verb reads was silently ignored. Running `pin ... --mode ipns` after the `--set-mode` rename parsed cleanly, published no IPNS record, and stored `mode: ipfs`, which would have made `republish` skip the name until it lapsed. Each verb now declares its flags, an unknown one is a loud error listing the accepted set, and renamed flags get a hint (`--mode` suggests `--set-mode`).
- **eth.limo warming is visible and honest.** `status` and the dashboard now PROBE the resolved `https://<name>.limo/` and report whether it serves, instead of only naming it; and `warm` no longer reports `warmed` for a site whose every fetch failed.
- **An inferred `ensName` no longer displays as `none`/`unset`.** A `.eth` site with no stored name showed "none" beside a working eth.limo link; it now shows the inferred name marked as inferred, in both the CLI and the dashboard.

Also pins the cloud-init agent version to `0.9.0`, the version this release publishes.
