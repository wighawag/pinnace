---
title: review-gate non-blocking nits for 'key-import-publisher' (Gate 2 approve)
date: 2026-07-24
status: open
reviewOf: key-import-publisher
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'key-import-publisher' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the in-scope decision: importIpnsKeyIntoPublisher THROWS KeyImportRoleError on a replica role rather than being a silent no-op. Is a loud refusal (a new user-visible error) the desired behaviour for a wrong-role import, or should it no-op?
  (src/publisher/key-import.ts:importIpnsKeyIntoPublisher + KeyImportRoleError; documented in module doc, ADR-0003 (Publisher-only), and the changeset. Gated on the EXISTING HostRole (publisher|replica) concept, invents no new role. Rationale given: a wrong-role import would place a signing key on a box that must stay keyless, so it is a caller error not a no-op. Looks correct and easily reversible; flagged only for human ratification since the task file carries no explicit Decisions block.)
- The static source-guard test greps the module source for sign(/.sign/createSign to enforce the no-client-signing invariant. This is brittle to future refactors (e.g. an unrelated identifier ending in .sign). Acceptable, but worth noting it guards text, not behaviour.
  (test/publisher/key-import.test.ts final case; complemented by the stronger RPC-seam assertion that ONLY key/import is issued (no name/publish/routing/put).)
