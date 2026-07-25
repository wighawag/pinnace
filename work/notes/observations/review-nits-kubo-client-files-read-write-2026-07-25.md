---
title: review-gate non-blocking nits for 'kubo-client-files-read-write' (Gate 2 approve)
date: 2026-07-25
status: open
reviewOf: kubo-client-files-read-write
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'kubo-client-files-read-write' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: filesRead returns Uint8Array rather than a decoded string. The task left the choice open (bytes as Uint8Array/text); every metadata consumer will now have to TextDecoder + JSON.parse itself. Confirm this is the intended client API before the sibling seam task builds on it.
  (packages/pinnace/src/rpc/kubo-rpc-client.ts:259 filesRead returns new Uint8Array(await res.arrayBuffer()))
- Ratify: filesWrite ships with NO options bag, contrary to the task's stated signature filesWrite(path, bytes, options?); create/parents/truncate are hard-coded and offset/count/cid-version are deliberately not exposed, and the call returns void (response discarded). The acceptance criterion only names filesWrite(path, bytes), so this meets the gate, but it is an unrecorded API-shape decision.
  (task What to build says filesWrite(path, bytes, options?); src/rpc/kubo-rpc-client.ts:240 implements filesWrite(path, bytes): Promise<void>)
- Ratify a cross-cutting refactor the task did not ask for: the shared private fileUpload helper was split into fileUpload (JSON decode) + a new fileUploadRequest (no decode), changing a helper used by add, dagImport, keyImport and routingPut. It reads behaviour-preserving, but it touches four existing endpoints outside this task's stated scope.
  (src/rpc/kubo-rpc-client.ts:306-334, fileUpload now delegates to fileUploadRequest)
- The one reason fileUploadRequest exists (files/write returns an EMPTY 200 body, so a JSON decode would throw) is never exercised: MockKuboApi returns a default JSON {} for any unregistered path, so the filesWrite tests would pass identically if filesWrite went through the JSON-decoding fileUpload. Add a case registering an empty text body, e.g. on files/write with text set to the empty string, so the regression is actually guarded. This is the same mock-fidelity gap class that let the raw-body upload ship before.
  (src/rpc/mock-kubo.ts fetchImpl default payload is {}; test/rpc/kubo-rpc-client.test.ts:312-366 never registers an empty body for files/write)
- For the downstream consumer: a missing MFS file and a broken/unauthorised node both surface as an untyped KuboRpcError with status 500, so the sibling task mfs-site-wrapper-layout-and-metadata-seam (which is told to tolerate absent metadata as empty) will have to swallow ALL read errors, silently masking node outage or auth failure as no metadata. The task specified exactly this shape so it is not a defect here, but the consumer task needs a narrower absence signal or an explicit decision to accept the conflation.
  (src/rpc/kubo-rpc-client.ts:259 filesRead; work/tasks/backlog/mfs-site-wrapper-layout-and-metadata-seam.md:15)
