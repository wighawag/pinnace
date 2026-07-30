---
title: Kubo's `routing/get` over the HTTP RPC returns a JSON QueryEvent with the record base64 in `Extra`, NOT raw record bytes
slug: kubo-routing-get-returns-a-json-envelope-not-the-record
source: 'kubo v0.38.1 core/commands/routing.go (getValueRoutingCmd: `res.Emit(routing.QueryEvent{Extra: base64.StdEncoding.EncodeToString(r), Type: routing.Value})`, with the raw-bytes writer living ONLY in its `cmds.Text` encoder), read 2026-07-30; CONFIRMED live the same day against the running publisher at https://ipfs-dash.ska.sh/records/ronan.eth.ipns-record, whose served body is `{"ID":"","Type":5,"Responses":null,"Extra":"CkEvaXBmcy9iYWZ5YmVpZ2J4ZGdpcW1z..."}` and whose base64-decoded `Extra` is a valid 397-byte IPNS protobuf for /ipfs/bafybeigbxdgiqmsxwsuocolyhfhlgxf4dgqtfxd4gorw45gcvh5vmdakey'
---

## The contract

`ipfs routing get /ipns/<name> > record` writes RAW record bytes, and Kubo's own `name inspect` help documents exactly that pipeline. It is easy to assume the HTTP RPC behaves the same way. **It does not.**

The command emits a `routing.QueryEvent` whose `Extra` field holds the record **base64-encoded**:

```go
return res.Emit(routing.QueryEvent{
    Extra: base64.StdEncoding.EncodeToString(r),
    Type:  routing.Value,
})
```

The raw bytes a shell redirect sees are produced by the command's **`cmds.Text` encoder**, which decodes `Extra` and writes it out. That encoder is selected by the CLI. Over the HTTP API the default encoding is **JSON**, so the response body is the envelope:

```json
{"ID":"","Type":5,"Responses":null,"Extra":"<base64 of the signed record>"}
```

So an HTTP client must **parse the JSON and base64-decode `Extra`** to obtain the record. Reading the response body as bytes yields the envelope, and reading it as text yields JSON that looks superficially plausible in a file.

## Why this bites harder than a normal wrong-shape bug

Three properties combine to make it silent:

1. **The envelope is still a non-empty, 200-OK body**, so no HTTP-level check fires. A `res.arrayBuffer()` succeeds and returns ~579 bytes of something.
2. **It is text**, so it survives being read as a string, written to a file, served over HTTP, re-read as a string, and handed onward, without any encoding step complaining. A pipeline that treats records as strings never notices.
3. **The failure only surfaces where something finally PARSES the record.** Kubo answers `record is malformed / proto: cannot parse invalid wire-format data`, and that is a 500 from whichever endpoint parsed it, which points at the parser rather than at the producer several hops upstream.

## The counterpart write path is NOT symmetric

`routing/put` takes the record as a `multipart/form-data` **`value-file` part of RAW bytes** (see `kubo-file-upload-multipart-contract.md`), and validates it: `api.Routing().Put` reaches `routing.PutValue`, which runs the `/ipns/` record validator. So the write side wants exactly what the read side does NOT hand you.

A round trip of `routing/get -> routing/put` is therefore broken by default: it re-announces the envelope, not the record. Any code that exports what `routing/get` returned, and any consumer that later puts it back, must do the base64 decode in between.

## Consequence for the record's on-disk/on-wire form

Once the decode is done, the record is **arbitrary binary protobuf**, not text. It cannot be carried by anything that round-trips through a string: `res.text()`, `readFile(path, 'utf8')`, `writeFile(path, string)` and `Buffer.from(string)` all apply UTF-8, which corrupts non-UTF-8 byte sequences irrecoverably. Any transport for a signed IPNS record has to be bytes end to end.

## Related

- `kubo-file-upload-multipart-contract.md` — the write side's multipart contract, including `routing/put`'s unusual `value-file` field name.
- `ipns-sequence-resets-to-zero-on-a-new-signer.md` — the sequence hazard, which is what led to a record finally being parsed, which is how this was found.
