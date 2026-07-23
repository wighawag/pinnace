---
'pinnace': minor
---

Add a typed per-node Kubo RPC client (`KuboRpcClient`) wrapping `POST /api/v0/...` with `Authorization: Bearer <token>`, covering `add`, `dag/import?pin-roots=true`, `files/{mkdir,rm,cp,ls,stat}`, `key/{list,gen,import}`, `name/publish`, `routing/{get,put}`, `id`. Non-2xx responses raise a loud `KuboRpcError` naming the endpoint + status. Ships a recording `MockKuboApi` fixture (the primary test seam sibling operations reuse), so all behaviour is proven over HTTP with no Kubo binary.
