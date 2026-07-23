---
title: review-gate non-blocking nits for 'ipns-key-derivation' (Gate 2 approve)
date: 2026-07-23
status: open
reviewOf: ipns-key-derivation
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'ipns-key-derivation' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- In-scope decision to RATIFY: the HKDF salt is pinned to empty (RFC 5869 default). The task/spec pins only ikm/info/length and never names a salt, so choosing empty-salt is a design choice the agent made on its own for a FROZEN, irreversible contract. It is documented in code and ADR-0001 and reproduces the golden vectors, but was not surfaced in a PR ## Decisions block. Ratify empty-salt as the frozen v1 choice.
  (deriveSeed passes new Uint8Array(0) as salt; ADR-0001 'HKDF salt = empty' section; commit body has no Decisions block.)
- The keyId/ensName-independence test asserts independence structurally (two identical deriveIpnsId calls) rather than by passing a differing ensName, because the derivation surface has no ensName parameter at all. This is correct and the strongest possible guarantee, but a reader expecting the task's literal 'same keyId + different ensName -> same id' shape may find the test name slightly misleading.
  (test 'is INDEPENDENT of the ENS name' calls deriveIpnsId twice with the same args; independence is structural (no ensName input), matching CONTEXT.md ENS name glossary.)
