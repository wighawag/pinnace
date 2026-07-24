---
title: review-gate non-blocking nits for 'car-build' (Gate 2 approve)
date: 2026-07-24
status: open
reviewOf: car-build
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'car-build' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: the build adds skipLibCheck:true to packages/pinnace/tsconfig.json. Un-recorded in-scope decision (no Decisions block in the PR/commit). It is documented in-line and scoped to third-party .d.ts only (ipfs-car -> @ipld/unixfs/actor), changing no runtime behaviour or public surface; the near-universal TS convention. Looks correct; human to ratify.
  (packages/pinnace/tsconfig.json diff; task ACs do not mention tsconfig)
- Ratify: a new exported helper writeCar(sourceDir,outPath) was added and exported from index.ts, beyond the task's buildCar surface. A thin convenience over buildCar that persists the CAR to disk; reasonable for the later deploy path. In-scope decision not named by the task; human to ratify.
  (src/car/car-build.ts writeCar; src/index.ts export; not in ACs)
- Ratify: buildCar throws (no files found under <dir>) on an empty source dir. Sensible refusal (nothing to deploy) and covered by a test, but a new user-visible error not spelled out in the ACs. Human to ratify.
  (src/car/car-build.ts empty-files guard; test 'rejects an empty source dir')
