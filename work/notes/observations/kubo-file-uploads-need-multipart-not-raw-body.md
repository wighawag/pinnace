---
title: KuboRpcClient sends dag/import (and add, key/import) as raw octet-stream; Kubo requires multipart/form-data
date: 2026-07-24
status: open
reviewOf: kubo-rpc-client
---

## What was observed (live Kubo v0.38.1)

`pinnace deploy` built the CAR fine (`cid: bafybei…`) but BOTH nodes rejected the
import:

```
Kubo RPC dag/import failed: 400 file argument 'path' is required
```

## Root cause

Kubo's file-upload RPC endpoints (`dag/import`, `add`, `key/import`) require the
payload as a **`multipart/form-data`** body with the data as a named file part.
`KuboRpcClient.dagImport` (and `add`, `keyImport`) instead POST the bytes as a
RAW `application/octet-stream` body:

```
// packages/pinnace/src/rpc/kubo-rpc-client.ts
dagImport(car) {
  return this.requestJson('dag/import', q, new Blob([car]), {
    'content-type': 'application/octet-stream',   // <-- wrong for Kubo
  });
}
```

Kubo can't find a multipart file part, so it errors "file argument 'path' is
required". The reference prototype `deploy-car.mjs` ALSO sent a raw `new Blob([car])`
(so the bug was ported faithfully), but real Kubo 0.38 rejects it.

## Why the mock tests didn't catch it

The `MockKuboApi` records the request body but does NOT enforce Kubo's actual
multipart contract, so `application/octet-stream` passed the mock while failing a
real daemon. This is the classic mock-fidelity gap: the seam was proven against a
fake that is more permissive than the real service.

## Fix

- Send `dag/import`, `add`, and `key/import` as `multipart/form-data` using Node's
  `FormData` (append the bytes as a `Blob` under the field name Kubo expects —
  `file` for add/dag-import; verify the exact field for key/import), and let
  `fetch` set the `content-type: multipart/form-data; boundary=…` automatically
  (do NOT hand-set content-type when passing FormData). Node's global `FormData`
  produces a correct multipart body (verified).
- Strengthen the mock / add a test asserting these endpoints send a
  `multipart/form-data` content-type with a file part (so the contract is guarded,
  closing the fidelity gap). Consider capturing Kubo's file-upload contract as a
  `notes/findings/` doc (per WORK-CONTRACT: a synthetic fixture for an external
  tool must match its real contract).

## Workaround

None client-side without the fix; the deploy cannot import until the client
sends multipart. (A manual `curl -F file=@site.car "…/dag/import?pin-roots=true"`
works, confirming multipart is the requirement.)
