---
title: review-gate non-blocking nits for 'cli-loadenv-dotenv-startup' (Gate 2 approve)
date: 2026-07-25
status: open
reviewOf: cli-loadenv-dotenv-startup
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'cli-loadenv-dotenv-startup' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: loadEnv() lives in a new startup shim (src/cli/startup.ts main()) with an injectable loadDotEnv seam, NOT inside run(). This keeps run(argv,{env}) hermetic. Reasonable and matches the task design.
  (Recorded in the PR Decisions block; startup.ts main() calls loadDotEnv() then run(argv); run() defaults context.env to process.env (run.ts:275,251).)
- Ratify: CONTEXT.md config-resolution glossary left as 'CLI arg > env (ldenv) > pinnace.json' rather than adding the .env.local/.env chain. Rationale: dotenv is a file source for the existing ldenv env layer, not a new domain concept. Coherent.
  (CONTEXT.md:26 unchanged; fuller precedence documented in package README where operators read it.)
