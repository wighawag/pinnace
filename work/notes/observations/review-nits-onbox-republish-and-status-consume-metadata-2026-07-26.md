---
title: review-gate non-blocking nits for 'onbox-republish-and-status-consume-metadata' (Gate 2 approve)
date: 2026-07-26
status: open
reviewOf: onbox-republish-and-status-consume-metadata
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'onbox-republish-and-status-consume-metadata' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the absent-mode exception: republish is now the ONE reader where a missing stored mode is NOT read as the ipfs default (it falls back to key presence). The agent amended the CONTEXT.md mode glossary entry and filed work/notes/observations/republish-absent-mode-is-not-read-as-ipfs-2026-07-26.md. The task mandates the tier, but the glossary now carries a load-bearing exception a human should sign off on.
  (src/publisher/record-sequence.ts:106-134; CONTEXT.md mode entry; task acceptance bullet 3)
- Cross-verb gap for a follow-up: the replica verb mirrorAndReannounce is NOT gated on stored mode. After an operator flips a live site to mode ipfs, the publisher stops refreshing but the already-exported <id>.ipns-record file stays on disk, so replicas keep fetching and routing/put-ing it. Once it expires, routingPut is a bare await inside the per-site loop with no try/catch, so a throw would abort the remaining sites in that mirror pass. Out of this task's scope, but worth a task: either sweep the exported record on an ipfs-mode skip, or gate/guard mirror.
  (src/publisher/record-sequence.ts:232-240 (routingPut unguarded); ipfs-mode skip leaves recordsDir untouched)
- Ratify the user-visible rendering defaults the task did not specify: the CLI status line prints mode unset / ensName unset / ensName opted-out / eth.limo none, and the dashboard gains three columns plus the first non-dweb.link outbound link (https://<name>.limo/), which required relaxing the page self-containment test. Values are escaped and URI-encoded, so no injection; the wording and the new outbound host are judgement calls.
  (src/cli/run.ts printedEnsName; src/status/status-html.ts ETH_LIMO_HOST + colspan 5 -> 8; test/status/status-html.test.ts self-contained assertion)
