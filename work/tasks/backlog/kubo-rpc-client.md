---
title: Typed Kubo RPC client tested against a mock HTTP API
slug: kubo-rpc-client
spec: pinnace
promptGuidance.testFirst: true
blockedBy: [scaffold-pinnace-package]
covers: [3]
---

## What to build

A small typed client in the core that wraps `POST /api/v0/...` against a Kubo node with `Authorization: Bearer <token>`, no Kubo binary on the client. This is the seam every host-agnostic operation (deploy, publish, status) speaks, so it must be the primary test boundary for the rest of the project: build it test-first against a **mock Kubo HTTP API that records requests** (method, path, query, headers, body shape), exactly as the originating-conversation prototype did.

Cover the verified endpoints the prototypes use: `add`, `dag/import?pin-roots=true`, `files/{mkdir,rm,cp,ls,stat}`, `key/{list,gen,import}`, `name/publish`, `routing/{get,put}`, `id`. Each method sends the bearer token and targets one node's base URL; the client is per-node (a deploy fans the same calls across many nodes, each with its own token, in a later task). Model non-2xx responses as loud errors carrying the endpoint + status (the prototype throws on `!ok`).

## Acceptance criteria

- [ ] A typed per-node client wraps the verified Kubo RPC endpoints listed above, sending `Authorization: Bearer <token>` on every call.
- [ ] A mock Kubo HTTP API test fixture records incoming requests and lets tests assert the exact method/path/query/headers per call.
- [ ] Test-first: the failing behaviour test at the RPC seam is written BEFORE the implementation (repo `promptGuidance.testFirst` is on).
- [ ] Non-2xx responses raise a loud error naming the endpoint and status.
- [ ] No Kubo binary is required; all interaction is over HTTP.
- [ ] Tests cover the new behaviour (per-endpoint request shape + auth header + error path), against the mock API, not a live daemon.

## Blocked by

- Blocked by `scaffold-pinnace-package` (needs the package + test toolchain).

## Prompt

> Goal: build the typed **Kubo RPC client** — the boundary all host-agnostic pinnace operations (deploy/publish/status) speak. It wraps `POST {nodeBaseUrl}/api/v0/<path>` with an `Authorization: Bearer <token>` header. No Kubo binary runs on the client; everything is HTTP.
>
> Domain vocabulary (CONTEXT.md): a **node** is reached ONLY via its Kubo RPC API, bearer-token guarded. The endpoints verified in the design conversation and used by the reference prototype `~/searches/ipfs-hetzner/deploy-car.mjs` are: `add`, `dag/import?pin-roots=true`, `files/{mkdir,rm,cp,ls,stat}`, `key/{list,gen,import}`, `name/publish`, `routing/{get,put}`, `id`. Read that prototype to see the exact query params (e.g. `files/mkdir?arg=/sites&parents=true`, `dag/import?pin-roots=true`) and the throw-on-`!ok` error handling — PORT the behaviour into typed TS, do not copy verbatim.
>
> Test at the RPC boundary with a MOCK Kubo HTTP API that records requests (as the prototype's tests did). This is the highest useful seam per the spec's Testing Decisions, and later tasks (deploy, status, publisher) will reuse this mock. Write the failing request-shape/auth test FIRST, then implement (test-first is on).
>
> The client is PER-NODE (one base URL + one token). Multi-target fan-out lives in the deploy task, not here. Done means: each endpoint sends the bearer token, hits the right path/query, and non-2xx throws a loud endpoint+status error, all proven against the mock API.
