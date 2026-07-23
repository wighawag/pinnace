---
title: CI emitter behind a CIProvider seam (GitHub Actions first)
slug: ci-emitter-github
spec: pinnace
promptGuidance.testFirst: true
blockedBy: [scaffold-pinnace-package]
covers: [16, 17]
---

## What to build

`install-ci` in the core: emit a deploy pipeline behind a `CIProvider` interface whose first implementation is `github` (GitHub Actions). It writes a deploy workflow AND reports the repo secrets/vars the operator must set. The workflow must support MULTIPLE target nodes and per-site `mode` — deploy the same CID to all nodes and publish only where appropriate (publisher first in the target list; replicas mirror) — mirroring the reference workflow's shape.

Test by SNAPSHOTTING the generated workflow and asserting the required secrets/vars are reported (e.g. the multi-node `IPFS_API`/`IPFS_TOKEN` comma-separated inputs, `SITE_NAME`, `SITE_MODE`).

## Acceptance criteria

- [ ] `install-ci` emits a deploy pipeline behind a `CIProvider` interface; `github` (GitHub Actions) is the first implementation.
- [ ] The emitter both writes the workflow AND returns the list of required repo secrets/vars.
- [ ] The workflow supports multiple target nodes (comma-separated API/token) and per-site mode (deploy same CID everywhere; publish only where appropriate).
- [ ] Snapshot test of the generated workflow + an assertion that the required secrets/vars are reported.
- [ ] Test-first: the failing snapshot/secrets-report tests are written before the emitter.
- [ ] Tests cover the new behaviour and write only to their own temp fixtures.

## Blocked by

- Blocked by `scaffold-pinnace-package`.

## Prompt

> Goal: build pinnace's **`install-ci`** — emit a deploy pipeline behind a `CIProvider` seam, first implementation `github` (GitHub Actions). Read CONTEXT.md (`CI provider seam`) and spec user stories 16, 17 + "Install CI" in the Solution. It WRITES a deploy workflow and REPORTS the repo secrets/vars to set.
>
> Reference prototype: `~/searches/ipfs-hetzner/github-workflow.yml` — PORT its shape (checkout, setup-node, build, `deploy-car` step reading `IPFS_API`/`IPFS_TOKEN`/`SITE_NAME`/`SITE_MODE`, the run-summary) into the emitted workflow, do NOT copy verbatim. It must support MULTIPLE nodes (comma-separated `IPFS_API`/`IPFS_TOKEN`, publisher first) and per-site `mode` (same CID to all nodes; publish only where appropriate). Note: v1 emits ONLY GitHub Actions; other CI systems are Out of Scope but the seam must exist so they can be added later.
>
> Test-first (repo policy on): write a failing SNAPSHOT test of the generated workflow AND an assertion that the required secrets/vars list is returned. Done means the emitter produces the workflow + the secrets/vars report, snapshot-locked.
