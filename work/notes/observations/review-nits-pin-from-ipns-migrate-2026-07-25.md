---
title: review-gate non-blocking nits for 'pin-from-ipns-migrate' (Gate 2 approve)
date: 2026-07-25
status: open
reviewOf: pin-from-ipns-migrate
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'pin-from-ipns-migrate' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The user-facing packages/pinnace/README.md command table still documents only 'pinnace pin <cid> --as <name> [--mode ...]' and never mentions --from-ipns, so the headline story of this task (one-command ENS migration) is undiscoverable from the docs. The sibling pin task did update that row when it added --mode ipns. Should the README row (and the mode/pin glossary line above it) gain the migrate form?
  (packages/pinnace/README.md:143 (pin row, no --from-ipns); CONTEXT.md pin entry and .changeset/pin-from-ipns-migrate.md WERE updated, so only the README lags)
- Ratify decision 3 (nameResolve returns everything after /ipfs/, so a source name pointing INTO a directory yields <cid>/<subpath>): the claim that pin/add, files/cp and name/publish all accept that verbatim is asserted in the JSDoc and the decisions note but is neither unit-tested at the mock seam nor verified against a live daemon. A cheap mock test (Path: /ipfs/<cid>/sub returns <cid>/sub) would at least pin the parse.
  (src/rpc/kubo-rpc-client.ts:311-327 plus work/notes/observations/pin-from-ipns-migrate-decisions.md section 3; no test in test/ mentions a subpath)
- Ratify decision 2 (which node resolves): the source name is resolved on the FIRST target that answers, in pinnace.json host order, with later targets only as a reachability fallback and no cross-node agreement check. Consequence to accept: a stale or disagreeing first node's view of the name is what gets pinned, mitigated only by printing 'via <baseUrl>'.
  (src/pin/pin-external.ts resolveIpnsSource (sequential, first success wins); decisions note section 2)
- Ratify the two stdout/stderr surface changes: a migrate now prints an extra 'note: a snapshot of <src>, not a follow...' line (decision 7, recorded), and the new two-form PIN_USAGE block is also appended to the PRE-EXISTING pin errors such as the missing --as message (not recorded as a decision). A consumer parsing pin output sees both.
  (src/cli/run.ts PIN_USAGE (lines 668-670) is emitted by the --as-required and both source errors; the snapshot note at the end of runPin)
- Ratify decision 1's public-type consequence: PinExternalInput.cid is now OPTIONAL next to fromIpns, with the XOR enforced at runtime rather than in the type. Library callers keep working, but the compiler no longer forces a source to be supplied. A discriminated union (cid | fromIpns) would make it a compile-time error; is the runtime guard the intended trade?
  (src/pin/pin-external.ts PinExternalInput.cid?: string plus the two throw guards at the top of pinExternal; decisions note section 1)
