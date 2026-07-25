---
'pinnace': minor
---

Fix `KuboRpcClient.routingPut` to send the signed IPNS record as a `multipart/form-data` file part named `value-file` (the field Kubo requires), completing the multipart-upload fix. Previously it sent a raw body, which real Kubo rejects with `400 file argument 'value-file' is required` (so a replica could not `routing/put` re-announce a record against a live node).
