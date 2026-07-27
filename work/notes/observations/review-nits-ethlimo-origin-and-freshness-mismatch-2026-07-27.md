---
title: review-gate non-blocking nits for 'ethlimo-origin-and-freshness-mismatch' (Gate 2 approve)
date: 2026-07-27
status: open
reviewOf: ethlimo-origin-and-freshness-mismatch
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'ethlimo-origin-and-freshness-mismatch' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the widening of the exported GatewayProbe seam: it now resolves to a result object instead of a bare status number, which breaks any library consumer injecting its own probe, one release after the previous widening. The changeset is a minor and says BREAKING in prose. Also ratify the growth of the package public API: shortReason, classifyEthLimoResolution, unknownEthLimoResolution and four types are re-exported from src/index.ts.
  (src/status/status-report.ts GatewayProbe/GatewayProbeResult; src/index.ts:203-235; .changeset/ethlimo-origin-and-freshness-mismatch.md; decisions 1, 2, 8)
- Ratify that frozen wins over foreign for a name-publishing site: any /ipfs/<cid> under such a site reads frozen (amber) plus freshness stale (amber), so a site whose ENS points at ANOTHER publisher's cid never shows the red foreign state, only two attention states. The task allowed either reading and both facts are on the line, but the loudest signal is softened for a real mismatch.
  (src/status/ethlimo-resolution.ts classifyOrigin (publishesName branch returns frozen before any cid comparison); decision 4)
- Ratify that the roll-up token status ok/unverified still ignores both axes, so an existing consumer alerting on status.json will not notice a foreign origin or a stale root unless it reads the two new fields. Should the mismatch be surfaced anywhere in the roll-up, or is the field-level report the intended contract?
  (src/status/status-report.ts makeStatusOp comment; decision 10)
- Two classifier choices are user-visible but missing from the Decisions block: (a) a gateway that echoes the ENS name back in x-ipfs-path yields unknown with reason gateway echoed the ens name, a new unknown path nobody specified; (b) x-ipfs-roots is comma-split and only the FIRST root is compared, so a multi-segment answer is judged on its first entry. Both look right; they just need ratifying.
  (src/status/ethlimo-resolution.ts ECHOED_ENS_NAME_REASON and classifyFreshness raw.split(comma)[0])
- An ipfs-mode site whose ENS still points at its OWN /ipns/<id> reports red foreign naming its own ipns id, because publishesName returns false for a stored ipfs mode and the id comparison is skipped entirely. The underlying warning is real (nothing republishes that name once the mode is ipfs), but the wording accuses the operator's own identity of being foreign. Intended?
  (src/status/ethlimo-resolution.ts classifyOrigin: the ipns branch only compares input.ipns when publishesName(input) is true; no test covers ipfs-mode plus own ipns path)
- Two boxes can disagree on the same record: for a MODE-LESS site whose ENS holds /ipfs/<current cid>, the publisher (which holds the key) reports frozen, while a replica (no key, so publishesName is false) reports a green ours for the identical record. Is the per-node divergence acceptable, given decision 9 already accepts replicas reporting unknown for ipns sites?
  (src/status/ethlimo-resolution.ts publishesName falls back to key presence; two dashboards render different verdicts for one ENS record)
