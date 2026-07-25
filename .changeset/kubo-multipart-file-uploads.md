---
'pinnace': minor
---

Fix `KuboRpcClient` file uploads to use `multipart/form-data` (via `FormData`) for `dag/import`, `add`, and `key/import`, matching Kubo's real HTTP contract. Previously these sent a raw `application/octet-stream` body, which real Kubo rejects with `400 file argument 'path' is required` (so `deploy` could not import a CAR against a live node). The mock now enforces the multipart contract so the regression is caught without a live daemon.
