---
title: review-gate non-blocking nits for 'cloud-init-pinnace-install-channel' (Gate 2 approve)
date: 2026-07-25
status: open
reviewOf: cloud-init-pinnace-install-channel
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'cloud-init-pinnace-install-channel' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- In-scope decision to ratify: this change wires the CLI flag --kubo-version for the first time (kuboVersion was a typed generator input but had no flag). It rides along with the new --pinnace-version/--node-major flags. Confirm the runner is happy exposing --kubo-version now.
  (run.ts runProvision adds all three flags; changeset Decisions block records it. Prior a9b0218 had kuboVersion input+DEFAULT_KUBO_VERSION but no flag.)
- Ratify the deferral: Bug C from the observation (cloud-init reports status: done despite a failed runcmd) is explicitly left out of scope and pushed to a cloud-init-generation follow-up. Confirm that deferral is acceptable.
  (Decisions block + observation cloud-init-first-boot-ipfs-user-race-and-set-e-abort.md list bugs A/B/C; only A (|| true) and B (users: module + reorder) are fixed here.)
- Decisions block lives in the changeset rather than the done task file or an ADR. Acceptance asked it be recorded and linked from the done record. The changeset shares the task slug, so it is discoverable, but a pointer in the done record would be tidier.
  (.changeset/cloud-init-pinnace-install-channel.md carries the ## Decisions block; the done task file has no explicit link to it.)
