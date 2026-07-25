---
title: Refresh status after deploy/pin so the dashboard is not stale (client feedback + on-box render)
slug: status-refresh-after-mutations
spec: pinnace
needsAnswers: true
covers: [15, 18]
---

## Open questions (a human must decide the approach)

The core tension: a mutating client command (`deploy` / `pin`) runs on the OPERATOR'S laptop and speaks ONLY Kubo RPC; the on-box dashboard (`/var/www/ipfs-dash/index.html`) is written to the BOX's local filesystem by the on-box `pinnace node status` systemd timer (default every 15 min). So a client mutation cannot re-render the on-box dashboard over RPC (RPC exposes no web-root write), and there is a stale window between "I deployed/pinned" and "the dashboard shows it". pinnace deliberately does NOT SSH (it is RPC-only, host-agnostic). Decide how far to close this:

1. **Client-side instant feedback (low-risk, in-architecture):** `deploy`/`pin` already hold the new per-site state (they just placed it in MFS) — print the resulting per-site status line(s) so the OPERATOR sees the new state immediately at the command, without waiting for the on-box render. Does this alone satisfy the need? (The dashboard is a passive, eventually-consistent view; the command output is the authoritative "did it land".)
2. **Shorten the on-box `status` timer** (e.g. 15min -> 3-5min) so the dashboard converges faster. Cheap; still a poll; more load. Combine with (1)?
3. **On-box render trigger without SSH:** is there an acceptable RPC-only or on-box mechanism to kick `pinnace node status` right after a client mutation? (e.g. a tiny bearer-guarded on-box HTTP hook Caddy proxies, or a Kubo pubsub message the box subscribes to, or accept that there is none and rely on 1+2). This is the load-bearing design call — do NOT invent a new network surface without ratifying it against the RPC-only / no-SSH principle.

4. **PREFERRED CANDIDATE (from the operator, 2026-07-25) — serve the dashboard from MFS so the CLIENT can write it over RPC.** The reason the client cannot refresh the dashboard is that it lives on the box FS (`/var/www/ipfs-dash/index.html`), unreachable over Kubo RPC. But Kubo's RPC DOES expose MFS writes (`files/write`), and `statusReport` + `renderStatusHtml` are PURE functions the client already imports. So: move the dashboard OUT of the box FS and INTO MFS (e.g. `/dashboard/index.html`), served by Caddy via the local gateway. Then ANY client op (`deploy`/`pin`/`status`) can gather status, render the HTML client-side, and `files/write` it into MFS over RPC — refreshing the dashboard with NO SSH, NO on-box timer needed for freshness (the timer becomes an optional backup). Kubo's RPC is Kubo's IPFS API, NOT a shell — it can never run `pinnace` on the box — so this MFS-served-dashboard is the RPC-only-honest way to make the client able to refresh it. This is likely the RIGHT design (it dissolves the client/on-box split for the dashboard), but it is a bigger reshape: add `filesWrite` to the client, relocate the dashboard to MFS, point Caddy at the gateway path, and keep/retire the on-box `status` render accordingly. Decide whether to adopt this (preferred) vs the lighter 1+2.

Resolve which of 1 / 2 / 3 (or a combination) is wanted, clear `needsAnswers`, then build. Do NOT build option 3's new surface without an explicit decision — it touches the host boundary.

## What to build (pending the decision above)

At minimum (option 1, almost certainly wanted regardless): make `deploy` and `pin` report the resulting per-site status so the operator gets immediate feedback (the "only one site on the dashboard" confusion came from the dashboard lagging a `pin`; the command itself should have shown the new site). Whether to also shorten the timer (2) and/or add an on-box render trigger (3) depends on the answers.

Keep the client/on-box boundary honest: the client does not write the box's web root; it either shows status itself (1) or triggers the on-box renderer through a sanctioned mechanism (3), never SSH.

## Acceptance criteria

- [ ] (decision recorded) The chosen approach (1 / 2 / 3 / combo) is decided, `needsAnswers` cleared, and the rationale recorded (a `## Decisions` note or CONTEXT.md line), respecting the RPC-only / no-SSH principle.
- [ ] `deploy` and `pin` report the resulting per-site state to the operator on completion (option 1), so a mutation gives immediate feedback without waiting for the on-box dashboard tick.
- [ ] If the timer interval is changed (option 2), the emitted cloud-init + its snapshot reflect the new `onUnitActiveSec` for `status` (and the trade-off is noted).
- [ ] If an on-box render trigger is added (option 3), it goes through a sanctioned, bearer-guarded mechanism (no new unauthenticated surface, no SSH), tested against the mock; otherwise this criterion is N/A and recorded as such.
- [ ] Test-first for whatever is built; no live daemon; the dashboard-write path stays on-box (client never writes the box FS).

## Blocked by

- None — `deploy-multi-target`, `pin-external-cid`, `status-report`, `dashboard-render-status-html`, `node-agent-commands` are all in `tasks/done/`.

## Prompt

> Goal: stop the dashboard/status from being stale right after a `deploy`/`pin` (the "only one site showing" confusion). FIRST resolve the open questions in this file — the client runs on the laptop over RPC-only (no SSH) and the dashboard is written on-box by the `status` timer, so the client cannot re-render the box's web root; decide between (1) client-side instant feedback (deploy/pin print the new per-site state — almost certainly wanted), (2) shortening the on-box status timer, and (3) a sanctioned on-box render trigger (only with an explicit decision — it touches the host boundary; never add an unauthenticated surface or SSH). Read the done tasks `dashboard-render-status-html`, `status-report`, `node-agent-commands`, `deploy-multi-target`, `pin-external-cid`, and CONTEXT.md (`core vs cli`, the on-box boundary ADR-0002). Build option 1 at minimum (report resulting status on deploy/pin), plus whatever the decision adds; keep the client/on-box boundary honest; test-first at the mock seam. Done means a mutation gives the operator immediate feedback and the dashboard converges promptly, without pinnace ever SSHing or writing the box FS from the client.
