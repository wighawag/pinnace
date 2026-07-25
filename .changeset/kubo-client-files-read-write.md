---
'pinnace': patch
---

Add `filesWrite(path, bytes)` and `filesRead(path)` to `KuboRpcClient`, so the client can create-or-replace and read an MFS file (the channel a site's `/sites/<id>/metadata.json` will travel on). `filesWrite` posts `files/write?arg=<path>&create=true&parents=true&truncate=true` with the bytes as a `multipart/form-data` `file` part (Kubo's file-upload contract), so a re-write fully REPLACES the file rather than appending into it; `filesRead` posts `files/read?arg=<path>` and returns the bytes. Both carry the node's bearer token and raise the loud `KuboRpcError` (endpoint + status) on any non-2xx, including a path that does not exist.
