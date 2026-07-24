---
title: Fix KuboRpcClient file uploads — use multipart/form-data for dag/import, add, key/import
slug: kubo-multipart-file-uploads
spec: pinnace
blockedBy: []
covers: [3, 4]
---

## What to build

Fix a confirmed live bug: `KuboRpcClient` sends the file-upload endpoints (`dag/import`, `add`, `key/import`) as a RAW `application/octet-stream` body, but real Kubo (v0.38.1) requires `multipart/form-data` with the payload as a named file part. Against real nodes, `pinnace deploy` fails with `dag/import failed: 400 file argument 'path' is required`. See `work/notes/observations/kubo-file-uploads-need-multipart-not-raw-body.md`.

Changes (in `packages/pinnace/src/rpc/kubo-rpc-client.ts`):
- Send `dagImport`, `add`, and `keyImport` as `multipart/form-data` using Node's global `FormData`: append the bytes as a `Blob` under the field name Kubo expects (`file` for `add` / `dag/import`; confirm the exact field name for `key/import`, historically also `file`/`key`), and let `fetch` set the `content-type: multipart/form-data; boundary=…` header AUTOMATICALLY. Do NOT hand-set `content-type` when the body is a `FormData` (setting it manually breaks the boundary).
- Keep the query params unchanged (`dag/import?pin-roots=true`, `key/import?arg=<name>`, etc.); only the body encoding + content-type handling changes.

Strengthen the test seam so this class of bug is caught without a live daemon:
- Update the `MockKuboApi` (or the affected tests) to ASSERT these endpoints send a `multipart/form-data` content-type and that a file part is present — i.e. make the mock enforce Kubo's real upload contract, not just record the body. The existing raw-octet-stream assertions for these three endpoints must be replaced with multipart assertions.
- Optionally capture Kubo's file-upload contract as a `work/notes/findings/` doc (with a `source:` — the live 400 + Kubo docs), per the WORK-CONTRACT rule that a synthetic fixture for an external tool must match its real contract.

## Acceptance criteria

- [ ] `dagImport`, `add`, and `keyImport` send `multipart/form-data` (via `FormData`), with the payload as a file part under the field name Kubo expects, and do NOT hand-set the `content-type` (fetch sets the boundary).
- [ ] Query params for those endpoints are unchanged (`pin-roots=true`, `arg=<name>`, etc.); the bearer auth header is still sent.
- [ ] The mock/tests ASSERT a `multipart/form-data` content-type + a file part for these three endpoints (the contract is guarded), replacing the old octet-stream assertions.
- [ ] Test-first: the failing multipart-contract test is written before the fix.
- [ ] (Optional but recommended) a `work/notes/findings/` doc captures Kubo's file-upload multipart contract with a `source:`.
- [ ] Tests run against the mock (no live daemon); no shared/global location touched.

## Blocked by

- None — `kubo-rpc-client` is in `tasks/done/`; this corrects its upload encoding. `deploy-multi-target` depends on this being right to work against real nodes (its mock tests pass regardless, but live deploy needs it).

## Prompt

> Goal: make `KuboRpcClient`'s file-upload endpoints work against real Kubo. Read the done task `kubo-rpc-client` and the observation `work/notes/observations/kubo-file-uploads-need-multipart-not-raw-body.md` (live 400 + root cause).
>
> Kubo's `dag/import`, `add`, and `key/import` require `multipart/form-data` with the payload as a named file part; the client currently sends raw `application/octet-stream`, so real Kubo 0.38 rejects it (`file argument 'path' is required`). Switch those three methods to build a `FormData` (append the bytes as a `Blob` under the field name Kubo expects — `file` for add/dag-import; confirm for key/import) and pass it as the body WITHOUT a manual `content-type` (fetch sets the multipart boundary). Keep query params + bearer auth unchanged.
>
> Close the mock-fidelity gap that let this ship: make the mock/tests ASSERT multipart + a file part for these endpoints (test-first — write the failing assertion first). Optionally capture Kubo's upload contract as a `notes/findings/` doc with a `source:`. Done means the three upload endpoints send correct multipart bodies, proven by tests, so a real `deploy` imports the CAR successfully.
