---
title: Add filesRead + filesWrite to KuboRpcClient (MFS read/write for metadata)
slug: kubo-client-files-read-write
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: []
covers: [3, 4, 5]
---

## What to build

Add two MFS methods to `KuboRpcClient` so the client and the on-box loop can write and read `/sites/<id>/metadata.json` (the foundation the rest of this spec's tasks build on). Today the client wraps `files/{mkdir,rm,cp,ls,stat}` but NOT `files/write` or `files/read` — both are needed and neither exists.

- `filesWrite(path, bytes, options?)` -> `files/write?arg=<path>&create=true&parents=true&truncate=true` with the bytes as a `multipart/form-data` file part (the same upload discipline `dag/import`/`add`/`key/import` use — file uploads are multipart, not raw). Bearer on every call; loud `KuboRpcError` on non-2xx. (Confirm the exact Kubo query params for `files/write`: `create`, `parents`, and `truncate` are the ones that make an idempotent overwrite-or-create; a re-write of an existing file must fully replace it, not append.)
- `filesRead(path)` -> `files/read?arg=<path>` returning the file bytes (as `Uint8Array`/text); bearer; loud error on non-2xx. Reading a path that does not exist raises the loud endpoint+status error (callers that treat absence as "no metadata" catch it).

This is a thin, self-contained RPC addition mirroring the existing files/* methods; no site/metadata logic here (that is the sibling tasks).

## Acceptance criteria

- [ ] `filesWrite(path, bytes)` issues `files/write` with `create`/`parents`/`truncate` so it creates-or-fully-replaces the file, sending the bytes as a multipart file part with the bearer token; a re-write replaces (does not append).
- [ ] `filesRead(path)` issues `files/read?arg=<path>` with the bearer token and returns the file bytes; a non-2xx (incl. a missing path) raises a loud `KuboRpcError` naming the endpoint + status.
- [ ] Both are exercised against the recording `MockKuboApi` (request shape + auth + the multipart body for write), not a live daemon.
- [ ] Test-first: the failing request-shape/auth tests are written before the methods.
- [ ] Tests cover the new behaviour against the mock API (no live daemon / shared location).

## Blocked by

- None — can start immediately.

## Prompt

> Goal: add `filesWrite` + `filesRead` to `KuboRpcClient` (the per-node Kubo RPC client). Read the done task `kubo-rpc-client` (the client + the recording `MockKuboApi` + the multipart `fileUpload` helper the file-upload endpoints use) and CONTEXT.md (a node is reached only via its bearer-guarded Kubo RPC).
>
> `filesWrite(path, bytes)` -> Kubo `files/write?arg=<path>&create=true&parents=true&truncate=true`, bytes as a multipart file part (reuse the existing `fileUpload` discipline — Kubo file uploads are multipart/form-data, NOT a raw body; this was a live-verified requirement for dag/import etc.). It must create-or-fully-replace (truncate) so re-writing metadata replaces it. `filesRead(path)` -> `files/read?arg=<path>`, returns the bytes; a non-2xx (including a missing file) throws the loud `KuboRpcError(endpoint, status)`. Bearer on both. Test-first against the mock API: assert the exact path/query/auth and the multipart body for write, and the read path + error. No live daemon. Done means the client can write + read an MFS file, ready for the metadata tasks to use.
