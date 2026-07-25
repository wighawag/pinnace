---
title: Refresh status after deploy/pin so the dashboard is not stale (client feedback + shorter timer)
slug: status-refresh-after-mutations
spec: pinnace
covers: [15, 18]
---

## Decision (RESOLVED 2026-07-25) — build option 1 + 2; node keeps owning status

The direction is decided (see "Recommended resolution" below): the NODE owns its
status (ADR-0002), so the client does NOT author the dashboard. Build the split:
(1) `deploy`/`pin` PRINT resulting per-site status to the operator's terminal
(client reporting what it did), and (2) shorten the on-box `status` timer so the
passive dashboard converges promptly. Options 3 (on-box trigger) and 4
(client-authored MFS dashboard) are rejected — see below.

## Design record (the options weighed)

The core tension: a mutating client command (`deploy` / `pin`) runs on the OPERATOR'S laptop and speaks ONLY Kubo RPC; the on-box dashboard (`/var/www/ipfs-dash/index.html`) is written to the BOX's local filesystem by the on-box `pinnace node status` systemd timer (default every 15 min). So a client mutation cannot re-render the on-box dashboard over RPC (RPC exposes no web-root write), and there is a stale window between "I deployed/pinned" and "the dashboard shows it". pinnace deliberately does NOT SSH (it is RPC-only, host-agnostic). Decide how far to close this:

1. **Client-side instant feedback (low-risk, in-architecture):** `deploy`/`pin` already hold the new per-site state (they just placed it in MFS) — print the resulting per-site status line(s) so the OPERATOR sees the new state immediately at the command, without waiting for the on-box render. Does this alone satisfy the need? (The dashboard is a passive, eventually-consistent view; the command output is the authoritative "did it land".)
2. **Shorten the on-box `status` timer** (e.g. 15min -> 3-5min) so the dashboard converges faster. Cheap; still a poll; more load. Combine with (1)?
3. **On-box render trigger without SSH:** is there an acceptable RPC-only or on-box mechanism to kick `pinnace node status` right after a client mutation? (e.g. a tiny bearer-guarded on-box HTTP hook Caddy proxies, or a Kubo pubsub message the box subscribes to, or accept that there is none and rely on 1+2). This is the load-bearing design call — do NOT invent a new network surface without ratifying it against the RPC-only / no-SSH principle.

4. **MFS-served dashboard written by the CLIENT — CONSIDERED AND REJECTED (operator, 2026-07-25).** It IS technically possible: Kubo's RPC exposes MFS writes (`files/write`) and `statusReport`/`renderStatusHtml` are pure functions the client imports, so a client could render + `files/write` the dashboard into MFS over RPC (no SSH). BUT this INVERTS the node-autonomy principle (ADR-0002: the box runs the same binary and OWNS its recurring loop, incl. status). If the CLIENT authors the node's self-report, the dashboard is only as fresh as the last time someone ran a command (stale for a week if untouched, even though the node ran fine the whole time), two clients could write conflicting status, and the status reflects what a client could see over RPC at a moment rather than the node's own continuous view. The clean line: the CLIENT may place CONTENT into MFS (that is doing an operation — deploy/pin put sites at /sites/*), but the NODE'S SELF-REPORT (status) must be authored by the NODE. So the node keeps owning status; do NOT move dashboard authorship to the client. (Kubo RPC is IPFS ops, never a shell — it can never run `pinnace` on the box — which is WHY the node, not the client, must own the on-box render.)

Resolve which of 1 / 2 / 3 (or a combination) is wanted, clear `needsAnswers`, then build. Do NOT build option 3's new surface without an explicit decision — it touches the host boundary.

## Recommended resolution (2026-07-25)

The operator's own principle settles it: the NODE owns its status (ADR-0002), so
do NOT make the client author the dashboard (option 4 rejected above). The
tension splits into two things with two DIFFERENT owners, neither of which needs
the client to write the node's dashboard:

- **"What just happened?" (instant, per-operation) = the CLIENT's job** ->
  option 1: `deploy`/`pin` PRINT the resulting per-site status to the operator's
  terminal (they already hold the data). This is the client reporting what it
  just did, NOT authoring the node's dashboard.
- **"What is this node's current state?" (continuous, passive) = the NODE's job**
  -> the on-box `status` timer renders the dashboard. Its only real problem is
  CADENCE -> option 2: shorten `onUnitActiveSec` for `status` (15min -> ~3-5min)
  so the passive view converges promptly while the node stays autonomous.

So build **1 + 2**: client-side per-op feedback + a shorter status timer. This
keeps the node the sole author of its own status, gives the operator immediate
feedback at the command, and makes the dashboard converge in minutes. Option 3
(an on-box trigger) is unnecessary given 1+2 and is not worth a new network
surface; option 4 (client-authored dashboard) is rejected on the autonomy
principle. (This resolves `needsAnswers`.)

Keep the boundary honest: the client PLACES CONTENT in MFS (deploy/pin) and
REPORTS what it did to the terminal; it never authors the node's self-report or
writes the box web root.

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
