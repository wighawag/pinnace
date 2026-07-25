---
title: Render a status dashboard index.html from `pinnace node status`
slug: dashboard-render-status-html
spec: pinnace
blockedBy: []
covers: [15, 18]
---

## What to build

Make `pinnace node status` write a rendered, human-readable **`index.html`** to the dashboard dir (alongside the existing `status.json`), so visiting `https://<dashboard-domain>/` shows a table of the node's sites and their health — instead of only raw JSON. The dashboard vhost is already a Caddy `file_server` over the dashboard dir, and `node status` already runs on a timer and writes `status.json`; this just adds a rendered HTML output from the SAME `StatusReport` data.

Data available (do NOT re-gather it — reuse what `status` already produces):
- `StatusReport`: `{ peerId, generated, sites: SiteStatus[] }`
- `SiteStatus`: `{ id, cid, ipns?, announced, gatewayServes }`

The rendered `index.html` should show, per site: the `id`, the `cid` (linked to a public gateway, e.g. `https://<cid>.ipfs.dweb.link/`), the `ipns` id if present (linked to `https://<ipns>.ipns.dweb.link/`), and `announced` / `gatewayServes` as clear status indicators (e.g. ok/no). Include the node's `peerId` and the `generated` timestamp in a header. Keep it a SINGLE self-contained static HTML file (inline CSS, NO external assets, NO client-side JS required — the data is baked in at render time), served correctly by Caddy `file_server` as the vhost root.

**Auto-reload (so the page does not go stale):** include a `<meta http-equiv="refresh" content="<seconds>">` in the page so the browser re-requests it periodically and picks up whatever the `status` timer last re-rendered. Use meta-refresh (an HTML attribute), NOT client JS, so the page keeps working with JS disabled and the "no required JS" principle holds. The interval should be sensible RELATIVE to the status timer cadence (the `status` timer regenerates every ~15min via `onUnitActiveSec`), so a very fast reload just re-fetches identical content: default around 300s (5 min), and make it a small named constant / render-arg so it is easy to change (not a bare magic number). Show the `generated` timestamp prominently so a viewer can see how fresh the data is regardless of reload timing.

Implementation notes:
- Render in the command layer next to `writeStatusReport` (the on-box wiring that already writes `status.json` to `ctx.dashboardDir`), so it writes BOTH `status.json` and `index.html` there, and ONLY there (respect the existing dashboard-dir isolation — never a global path).
- Keep `status.json` as-is (machine-readable); `index.html` is the human view of the same data.
- Escape site-controlled strings (`id`, `cid`, `ipns`) when interpolating into HTML (they are operator-supplied but still: no unescaped interpolation, to avoid a broken/injected page).
- The renderer should be a PURE function (`StatusReport -> html string`) so it is unit-testable without touching the filesystem; the command layer writes what it returns.

Note on scope: this is the PER-NODE dashboard (each box shows its OWN sites, auto-discovered from its MFS). A single aggregated multi-node dashboard is out of scope (a publisher polling replicas is a separate, larger feature).

## Acceptance criteria

- [ ] `pinnace node status` writes a rendered `index.html` to the dashboard dir (alongside `status.json`), served at the dashboard vhost root.
- [ ] The HTML shows, per site: `id`, `cid` (gateway-linked), `ipns` id if present (gateway-linked), and `announced` / `gatewayServes` as clear indicators; plus the node `peerId` + `generated` timestamp.
- [ ] It is a single self-contained static file (inline CSS, no external assets, no required client JS); site-controlled strings are HTML-escaped.
- [ ] The page auto-reloads via `<meta http-equiv="refresh">` at a sensible interval (default ~300s, aligned with the ~15min status timer; a named constant/arg, not a magic number), and shows the `generated` timestamp so freshness is visible. No client JS is required for this.
- [ ] The renderer is a pure `StatusReport -> string` function, unit-tested (a `StatusReport` fixture renders the expected fields/links/escaping) without filesystem access.
- [ ] `status.json` output is unchanged; the command layer writes both, only under `ctx.dashboardDir` (isolation preserved; tests assert no other location is written).
- [ ] Test-first: the failing renderer test is written before the implementation.

## Blocked by

- None — `status-report` + `node-agent-commands` (the `status` verb + `writeStatusReport`) are in `tasks/done/`; this adds an HTML output to the existing write.

## Prompt

> Goal: give `pinnace node status` a human dashboard — render an `index.html` (not just `status.json`) to the dashboard dir, so `https://<dashboard-domain>/` shows the node's sites + health. Read the done tasks `status-report` (the `StatusReport`/`SiteStatus` shape) and `node-agent-commands` (`runNodeCommand` + `writeStatusReport`, which already writes `status.json` to `ctx.dashboardDir`). The dashboard vhost is a Caddy file_server over that dir.
>
> Reuse the data `status` already gathers (`StatusReport { peerId, generated, sites: {id, cid, ipns?, announced, gatewayServes}[] }`) — do NOT re-fetch. Add a PURE renderer `renderStatusHtml(report): string` producing a single self-contained static HTML page (inline CSS, no external assets, no required JS): a header with peerId + generated timestamp, and a table row per site (id; cid linked to a public gateway; ipns id linked if present; announced/gatewayServes as ok/no indicators). HTML-escape the site-controlled strings. Include a `<meta http-equiv="refresh" content="...">` so the browser re-requests the page periodically (the status timer re-renders it every ~15min) — meta-refresh, NOT JS — with a sensible default (~300s) exposed as a named constant/arg, and show the `generated` timestamp so freshness is visible. Have the command layer write BOTH `status.json` and `index.html` under `ctx.dashboardDir` (only there — keep the isolation). Test-first: assert the renderer output for a `StatusReport` fixture (fields, links, escaping) with no filesystem access; assert the writer writes index.html next to status.json and nowhere else. Done means the dashboard vhost root shows a readable per-site status page that self-updates on the status timer.
