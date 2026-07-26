---
'pinnace': patch
---

Close the two paths through which a write could silently destroy a site's stored MFS metadata.

`site add` now PRESERVES: it states neither `mode` nor `ensName`, and stating nothing is not a licence to overwrite, so it resolves its `metadata.json` through the same `resolveSiteMetadataToWrite` seam `deploy`/`pin` use. Re-adding an existing site keeps its stored `ensName` and its stored `mode` (it no longer demotes a published `ipns` site to `ipfs` and drops its eth.limo name); a FIRST add still records `{mode: 'ipfs'}` — the DEFAULT mode of a site that stores none, not a report of the placement it performed.

On the WRITE path, "this site stores nothing" must now be established POSITIVELY, from a successful `files/ls` that does not list `metadata.json` (walking up to the sites dir, and to the MFS root, so a first deploy and a fresh box are still clean absences). Any other failure — the listing itself failing, or the file being listed but unreadable — is an OUTAGE, and the write is REFUSED with a loud `SiteMetadataUnreadableError` naming the site, the node and the failed step, writing nothing. Previously a down or 401ing node made a no-flag re-deploy/re-pin resolve to `ipfs`, overwrite the stored metadata and exit 0. Kubo's error text is never inspected; the shape of a successful listing is the signal. An operator can still write through an unreadable node by stating the whole record (`--set-mode` plus `--set-ens-name`/`--unset-ens-name`), which needs no read at all.

The tolerant discovery read is unchanged: `discoverSites` (and the on-box `warm`/`republish`/`status` loop it feeds) still reads absent, malformed or unreadable metadata as empty and never fails the pass. New from the package root: `readSiteMetadataForWrite` and `SiteMetadataUnreadableError`; `KuboRpcClient.baseUrl` is now public so an error can name its node.
