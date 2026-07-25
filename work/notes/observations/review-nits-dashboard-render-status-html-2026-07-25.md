---
title: review-gate non-blocking nits for 'dashboard-render-status-html' (Gate 2 approve)
date: 2026-07-25
status: open
reviewOf: dashboard-render-status-html
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'dashboard-render-status-html' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the renderer's input type: the task specified a pure StatusReport -> string function, but the code introduces NEW exported types StatusPageReport / StatusPageSite (every field but id optional) instead of reusing StatusReport / SiteStatus. It is structurally compatible (StatusReport has no generated field, and the command layer holds SiteOutcome, not SiteStatus, so a wider shape is defensible), but it adds a second report vocabulary to the package's public API. Ratify, or narrow it to StatusReport plus a generated arg.
  (src/status/status-html.ts:44-80 (StatusPageSite/StatusPageReport) and src/index.ts exports both new types alongside StatusReport/SiteStatus)
- Ratify the cross-module seam change: peerId was added as an optional field on the SHARED NodeOpResult (used by republish/mirror/warm too) and is filled by makeStatusOp in status-report.ts, a module owned by another task, purely so the page header can name the node. It is deliberately kept OUT of the status.json payload (asserted by test). Confirm this is the seam you want rather than passing peerId to the renderer from the command layer's own id read.
  (src/node/node-commands.ts NodeOpResult.peerId; src/status/status-report.ts makeStatusOp returns peerId; test/node/node-commands.test.ts:446 asserts status.json keys stay generated+sites)
- Ratify a user-visible default: an ABSENT announce / gatewayServes check renders as a red no, not as unknown. On the production path (makeStatusOp injected) both fields are always present, so no real user is misled; but a bare runNodeCommand with the thin defaultStatus op writes an index.html showing every site as no/no, which reads as broken rather than not-checked. Consider a third neutral state for undefined.
  (src/status/status-html.ts indicator(): returns the no span for undefined; src/node/node-commands.ts defaultStatus() sets neither field)
- Ratify the hardcoded public-gateway hosts, and note the duplication: the page always links dweb.link (IPFS_GATEWAY_HOST / IPNS_GATEWAY_HOST) regardless of the operator's configured ctx.gateways, and ipfs.dweb.link is now spelled in two modules (status-html.ts and status-report.ts DWEB_LINK_HOST). The task named dweb.link as the example, so this is in-spec; a later gateway change must touch both places.
  (src/status/status-html.ts:40-43 vs src/status/status-report.ts DWEB_LINK_HOST)
- Should CONTEXT.md pin the dashboard vocabulary (dashboard dir / dashboard vhost / the two outputs status.json = machine, index.html = human)? The glossary has no dashboard entry, yet the term is now load-bearing across cloud-init, node-commands and this renderer, and records/ also lives under the same dir.
  (CONTEXT.md core domain terms has no dashboard entry; cloud-init.ts DASHBOARD_DIR=/var/www/ipfs-dash with RECORDS_DIR beneath it)
