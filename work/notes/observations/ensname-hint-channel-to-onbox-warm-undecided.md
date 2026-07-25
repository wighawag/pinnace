---
title: No channel for a site's ensName (client config) to reach the on-box warm loop — a real design decision
date: 2026-07-25
status: open
---

## What was found (via a build-agent STOP on ensname-resolution-and-eth-opt-out)

The task `ensname-resolution-and-eth-opt-out` proposed a three-way eth.limo
warming rule driven by the `ensName` field (explicit > `.eth`-inference > `""`
opt-out). The build agent correctly STOPped: `ensName` lives ONLY in the
CLIENT's `pinnace.json` (`SiteConfig.ensName`), but `warm` is an ON-BOX verb that
discovers sites from MFS `/sites/*` (only the `id`, no ensName) and reads only
`/etc/pinnace-node.env` (zero per-site data). So there is NO channel for
`ensName` to reach the box, and 3 of the 4 cases (explicit ensName, `""` opt-out)
cannot fire on a real box. Only case 2 (`.eth`-id inference) is reachable — which
is what the code already does. Implementing the seam + doc rewrite alone would
"document a lever nothing can pull", reproducing the exact defect.

Full agent analysis: `work/questions/task-ensname-resolution-and-eth-opt-out.md`.

## The undecided design (a human must choose)

How do per-site ENS warming hints reach the on-box warm loop? Options (agent's,
each with a hard-to-reverse cost):
- (a) snapshot into `/etc/pinnace-node.env` at provision (`WARM_ENS_NAMES=...`):
  provision starts carrying site data (contradicts "provision is arg-driven"),
  STALE by construction (change/add a site => re-provision or hand-edit).
- (b) deploy pushes hints to on-box state: no channel; deploy is RPC-only, cannot
  write box files.
- (c) store the hint in MFS next to the site (`/sites-meta/<id>/ens`): invents a
  new MFS metadata concept, changes what `discoverSites` means.
- (d) keep the box id-based; make `ensName` a client-side lever only: the
  recurring on-box loop (ADR-0002) still ignores ensName.

## Connection to the status-refresh decision (same shape, consistent principle)

This is the SAME question as `status-refresh-after-mutations`: how does
client-only knowledge reach the on-box recurring loop? There, the operator's
principle was: the NODE owns what it does continuously; client-only config should
not secretly drive the box; the box keys off what IT can see. Applied here, that
argues AGAINST (a)/(c) (pushing client config into box state) and FOR the box
keeping its `.eth`-suffix inference (the id IS what the box can see), with any
explicit-ensName / `""`-opt-out being a CLIENT-side concern (client-side warm /
status), not an on-box loop input. I.e. option (d)-ish, or simply "the `.eth` id
is the box's signal, and that is fine".

## Also: spec + phantom-gateway issues the agent flagged

- The `pinnace` spec (still `specs/tasked/`) stories 9 + 15 SANCTION the current
  `.eth`-name behaviour ("eth.limo for `.eth` names ... for every site discovered
  in MFS"). The ENS-demotion idea says this is a SPEC-level reshape needing
  reopen -> reconcile -> re-task; the task jumped ahead of that step.
- `eth.link` appears NOWHERE in the code (only `<id>.limo` is warmed;
  `DEFAULT_GATEWAYS` = dweb.link/cf-ipfs.com/ipfs.io). The task's "and eth.link"
  is dead wording or an unstated new-gateway default.

## Disposition

The flawed task is cancelled (superseded by this decision). Re-approach when the
operator decides the channel question above. Likely resolution (pending their
call): keep the box's `.eth`-id inference as-is (autonomous, matches spec story
15), and treat explicit-ensName/opt-out as a client-side nicety if wanted — NOT
an on-box loop change. If instead they want box-level per-site ENS control, it is
a spec reconcile (stories 9/15) + a decision on the channel (a/c) with the
staleness tradeoff, THEN implementation — three steps, not one task.
