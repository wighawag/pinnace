---
'pinnace': patch
---

The on-box loop now ACTS on the per-site metadata it could already see: `republish` obeys the stored `mode`, and `status` reports it.

`republish` used to decide whether to sign purely from keystore-key presence, so a site the operator deliberately stores as `mode: ipfs` was still signed and republished whenever a key happened to exist for its id (left over from an earlier ipns life, or derived for a sibling purpose). It now resolves per site: a stored `ipfs` is NEVER published, even with a key, and reports its own `ipfs-mode` outcome rather than `no-key` (which would claim a key was missing when one is present); a stored `ipns` behaves exactly as before (key -> `exported`, no key -> `no-key`); and a site with NO stored mode also behaves exactly as before, key presence deciding, so an existing live site placed before metadata existed keeps republishing.

`status` reported nothing from the metadata, so an operator could not see what the box would do with a site. `SiteStatus` (and the `node status` payload, `status.json`, and the dashboard page) now carry the stored `mode`, the stored `ensName` and `ensNameToWarm` — the eth.limo name resolved by the same `resolveEnsNameToWarm` rule the on-box `warm` loop uses, never a second copy of it. The three-valued `ensName` stays three-valued end to end: `""` (opt out) is reported as `""` and never flattened to absent, absent leaves no key in the JSON at all, and the dashboard renders "opted out" and "none" differently. The dashboard table gains `mode`, `ens name` and a linked `eth.limo` column; `pinnace status` prints the same three per site.
