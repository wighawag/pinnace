---
title: Fix KuboRpcClient routingPut — multipart/form-data with the `value-file` field (live 400)
slug: kubo-routing-put-multipart-value-file
spec: pinnace
blockedBy: []
covers: [3, 12]
---

## What to build

Complete the Kubo multipart-upload fix: `routing/put` was MISSED by `kubo-multipart-file-uploads` (which converted `dag/import`, `add`, `key/import`). Against a real Kubo v0.38.1, the replica's re-announce fails:

```
Kubo RPC routing/put failed: 400 file argument 'value-file' is required
```

`KuboRpcClient.routingPut` still sends the signed record as a RAW `application/octet-stream` body, but Kubo's `routing/put` requires the record as a `multipart/form-data` file part — AND the part must be named **`value-file`** (NOT the generic `file` the existing `fileUpload` helper uses). See `work/notes/observations/kubo-file-uploads-need-multipart-not-raw-body.md` (same class of bug) and the live findings note on the record transport.

Changes (in `packages/pinnace/src/rpc/kubo-rpc-client.ts`):
- Send `routing/put` as `multipart/form-data` with the record bytes as a file part named `value-file`, letting `fetch` set the boundary (no hand-set content-type). The existing `fileUpload` helper hardcodes the field name `file`, so either generalise it to take the field name (default `file`, `value-file` for routing/put) or add a dedicated path.
- Keep the query params unchanged (`routing/put?arg=<ipnsPath>`) and the bearer auth.
- Verify `routing/get` does NOT need the same change (it is a body-less POST that returns bytes; only the WRITE side takes a file). If it turns out to need multipart too, fix it under the same task and note it.

Strengthen tests (the mock let this through because it does not enforce Kubo's field-name contract):
- Assert `routing/put` sends `multipart/form-data` with a file part named `value-file` (test-first: write the failing assertion first).
- Update the record-sequence tests that exercise `routing/put` if they asserted the old raw-body shape.

## Acceptance criteria

- [ ] `routingPut` sends `multipart/form-data` with the record as a file part named `value-file`, no hand-set content-type (fetch sets the boundary), query + bearer unchanged.
- [ ] A test asserts the `value-file` multipart contract for `routing/put` (replacing any old octet-stream assertion), written test-first.
- [ ] `routing/get` is confirmed correct as-is (or fixed under the same task if it also needs multipart), with a note either way.
- [ ] The `fileUpload` helper (or its replacement) supports a configurable field name without breaking the existing `file`-named uploads (`dag/import`/`add`/`key/import` still pass).
- [ ] Tests run against the mock (no live daemon); no shared/global location touched.

## Blocked by

- None — `kubo-multipart-file-uploads` (in `tasks/done/`) fixed the other three endpoints; this completes the set for `routing/put`. Live-verified as the next blocker after that fix landed.

## Prompt

> Goal: fix `KuboRpcClient.routingPut` to use `multipart/form-data` with the file part named `value-file`, completing the multipart-upload fix (`dag/import`/`add`/`key/import` were done in `kubo-multipart-file-uploads`; `routing/put` was missed). Read that done task + `work/notes/observations/kubo-file-uploads-need-multipart-not-raw-body.md`.
>
> Live Kubo 0.38.1 rejects the current raw-octet-stream `routing/put` with `400 file argument 'value-file' is required`. Send the record as a multipart file part named `value-file` (NOT the generic `file`), via `FormData`, without hand-setting content-type. Generalise the existing `fileUpload` helper to accept the field name (default `file`; `value-file` for routing/put) so the other three endpoints are unaffected. Keep `routing/put?arg=<ipnsPath>` + bearer unchanged. Confirm `routing/get` needs no change (body-less read) or fix it too. Test-first: assert the `value-file` multipart contract for routing/put. Done means a live replica re-announce (`routing/put`) succeeds, proven by the mock contract test.
