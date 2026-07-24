---
title: record-sequence owns the logic but imports its context types from node-commands (inverted type home)
date: 2026-07-24
status: open
reviewOf: publisher-replica-model
---

## What was observed

Two related structural signals from the Gate-2 reviews of `node-agent-commands`
and `publisher-replica-model`, both around the `NodeCommandOps` seam:

1. **Inverted type home.** `publisher-replica-model` OWNS the record
   export/fetch/put/fallback sequence (`src/publisher/record-sequence.ts`), but
   it imports its context/site TYPES from `src/node/node-commands.ts` (import-type
   only), while `node-commands.ts` imports the concrete ops FROM
   `record-sequence.ts`. The core-owns-its-types direction is inverted. It works
   (type-only import, no runtime cycle, gate green), but the type home may want
   relocating so the owning module also owns its types.

2. **Transient op overlap.** `node-agent-commands` shipped `defaultRepublish` /
   `defaultMirror` implementing the FULL record sequence that
   `publisher-replica-model` owns, rather than thin stubs. Both now exist behind
   the `NodeCommandOps` seam (designed for replacement, so reversible), but until
   the wiring settles there is duplicated sequence logic across two modules that
   must not drift.

## Why this is a live signal (not yet verified)

The seam was explicitly designed for the owned ops to REPLACE the defaults, so
this is expected transitional overlap, not a bug. But nobody has confirmed the
production `NodeCommandOps` actually binds the `record-sequence` implementations
(vs. silently keeping the `node-commands` defaults), which is exactly the kind of
divergence that rots. This intersects the CLI-wiring follow-up
(`wire-client-cli-verbs-end-to-end`): when the node verbs are wired end-to-end,
confirm `DEFAULT_OPS` / the injected ops point at the OWNED `record-sequence`
functions and drop the duplicate, and relocate the shared types to the owning
module.

## Suggested disposition

Fold the "bind owned ops + relocate types" cleanup into the
`wire-client-cli-verbs-end-to-end` task (it already touches this dispatch path),
or spin a small dedicated refactor task. Discharge this note once that cleanup is
captured in a self-contained artifact or ratified as intended.
