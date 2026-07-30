---
'pinnace': patch
---

Fix the IPNS record export: `routing/get` was returning Kubo's JSON envelope, not the record, which broke replica re-announce.

Kubo's HTTP RPC does not return raw record bytes for `routing/get`. It returns a JSON `QueryEvent` with the record base64-encoded in `Extra`; the raw bytes a `ipfs routing get > file` redirect produces come only from the CLI's text encoder. `KuboRpcClient.routingGet` was reading the body as bytes, so it handed back the envelope.

That envelope is a 200-OK, non-empty, text body, so nothing upstream failed on it. The publisher wrote it to `/records/<id>.ipns-record`, replicas fetched it and `routing/put` it, and `routing/put` validates IPNS records, so the replica re-announce (the grace window the whole publisher/replica model exists for) could not work. It surfaced only once `status` started parsing records for the sequence number, as `record is malformed / proto: cannot parse invalid wire-format data`.

- `routingGet` now parses the envelope and base64-decodes `Extra`, and REFUSES loudly (naming the node) when the body is not JSON or carries no `Extra`, rather than returning an empty record that would later read as "this name has no record".
- The signed record is now BYTES end to end. `PublisherFetch` returns `Uint8Array`, the production fetch uses `arrayBuffer()`, and the replica cache is read and written as binary. A record is arbitrary protobuf, so any string round trip applies UTF-8 and corrupts it. Only the `.ipns-name` sidecar stays text.
- The test mock gained `routingGetBody()`, so the real wire shape is written down once. The old tests seeded `routing/get` with raw bytes, encoding a contract Kubo does not honour, which is why this reached production.

Exported records and cached records on existing boxes are rewritten in the correct form on the next `republish`/`mirror` timer tick.

Also makes the dashboard readable: long CIDs and IPNS ids are middle-elided for display (`bafybeigbx…mdakey`) with the full value in the link's `href` and `title`, long `unknown` reasons are truncated with the full text in a tooltip, and `word-break: break-all` is gone. At eleven columns a 59-character CIDv1 was being shredded into a one-character-per-line ribbon.
