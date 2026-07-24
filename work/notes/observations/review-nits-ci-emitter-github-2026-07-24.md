---
title: review-gate non-blocking nits for 'ci-emitter-github' (Gate 2 approve)
date: 2026-07-24
status: open
reviewOf: ci-emitter-github
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'ci-emitter-github' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The emitted workflow's Summary step reads steps.deploy.outputs.cid and outputs.ipns, so it imposes a contract that the not-yet-built 'pinnace deploy' CLI must write cid/ipns to GITHUB_OUTPUT. Ratify this cross-task expectation so deploy-multi-target / cli-command-wrapper honour it (else the run summary silently renders empty backticks).
  (src/ci/ci-emit.ts Summary step; deploy command does not exist yet)
- In-scope naming decisions the PR did not record in a Decisions block: workflow path/concurrency-group were rebranded from the reference ipfs-deploy to pinnace-deploy (pinnace-deploy.yml, group pinnace-deploy), and SITE_MODE default 'ipns' is baked into the emitted YAML. All reasonable and ported from the reference; flagging for ratification only.
  (renderGithubWorkflow: path .github/workflows/pinnace-deploy.yml, concurrency group pinnace-deploy)
