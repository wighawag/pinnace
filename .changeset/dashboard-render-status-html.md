---
'pinnace': minor
---

`pinnace node status` now renders a human dashboard page: alongside the machine-readable `status.json` it writes an `index.html` into the node's dashboard dir, so the dashboard vhost ROOT (`https://<dashboard-domain>/`) shows a readable per-site table (site `id`, gateway-linked `cid`, gateway-linked `ipns` id when present, and `announced` / `gateway` ok/no indicators) with the node's PeerID and the `generated` timestamp in the header.

The page is a single self-contained static file (inline CSS, no external assets, no client-side JS) rendered by the new pure `renderStatusHtml(report)` export from the SAME report `status` already gathers (nothing is re-fetched), and it stays fresh via `<meta http-equiv="refresh">` (default `DEFAULT_STATUS_REFRESH_SECONDS` = 300s, chosen against the ~15min on-box `status`-timer cadence, overridable per render). Both outputs are written under the configured dashboard dir only; the `status.json` payload is unchanged.
