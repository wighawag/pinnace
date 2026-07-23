---
title: On-box pinnace node subcommands (republish/mirror/warm/status) + boundary ADR
slug: node-agent-commands
spec: pinnace
promptGuidance.testFirst: true
blockedBy: [kubo-rpc-client, config-resolution]
covers: [2, 12, 13, 15]
---

## What to build

The on-box command surface of `pinnace`: a small set of subcommands the SAME `pinnace` binary exposes for running the recurring loop ON a node (invoked by systemd timers baked in by cloud-init), operating against the box's LOCAL Kubo RPC. This is the decided architecture: one codebase runs both as the operator's client CLI and as the box's periodic agent, so the record/warm/mirror/status logic has a single implementation (no bash/TS drift). The subcommands are thin wrappers over core operations, exactly like the client CLI.

The v1 on-box subcommands (name them under a `node` namespace, e.g. `pinnace node <verb>`):
- **`republish`** (publisher role): for each site whose key the node holds, `name/publish` refresh the record (~72h validity, ttl ~1h) and EXPORT the raw signed record (`routing/get`) to where replicas fetch it.
- **`mirror`** (replica role): for each site, fetch the publisher's exported record, `routing/put` re-announce it, FALLING BACK to the last cached record if the publisher endpoint is unreachable.
- **`warm`**: auto-discover sites from MFS `/sites/*` and re-fetch each site's current CID through the configured public gateways (dweb.link, ...); `.eth` names also via eth.limo.
- **`status`**: regenerate the node's status (per-site CID / IPNS id / announce / gateway-serves) for the dashboard — reusing the `status-report` core logic, written to the box's dashboard location.

Each subcommand self-gates on `NODE_ROLE` where relevant (republish only on publisher; mirror only on replica) so scheduling all timers on every box is safe. The actual publisher/replica record SEQUENCE (export -> fetch -> put -> fallback) is owned/tested in `publisher-replica-model`; this task provides the COMMAND surface those live in and wires warm + status.

Because "the box runs the same CLI while Kubo owns pinning + reprovide" is a non-obvious architectural boundary a future reader will question, write a **boundary ADR in `docs/adr/`** recording it: Kubo owns content pinning (`dag/import --pin-roots`) and provider-record freshness (`Reprovider.Interval`); pinnace's recurring on-box loop owns ONLY IPNS republish/export, replica mirror/fallback, gateway warm, and status; and the client CLI and the on-box agent are one binary (one implementation of the logic).

## Acceptance criteria

- [ ] `pinnace` exposes on-box subcommands under a `node` namespace: `republish`, `mirror`, `warm`, `status`, each a thin wrapper over core logic operating against the LOCAL Kubo RPC.
- [ ] `republish` (publisher) and `mirror` (replica) self-gate on `NODE_ROLE`; `warm`/`status` auto-discover sites from MFS `/sites/*`.
- [ ] `warm` re-fetches each site's CID through the configured gateways and `.eth` names via eth.limo; `status` reuses the `status-report` core logic.
- [ ] An ADR under `docs/adr/` records the boundary: Kubo owns pinning + reprovide; pinnace's on-box loop owns only IPNS republish/export + mirror/fallback + warm + status; client CLI and on-box agent are ONE binary.
- [ ] Tests assert each subcommand dispatches the correct core operation / Kubo RPC calls against the MOCK Kubo API + fakes (no live daemon), and that role-gating skips the wrong-role verbs.
- [ ] Test-first: the failing dispatch/role-gating tests are written before the wiring.
- [ ] Tests isolate any on-box paths they write (dashboard/cache) to temp fixtures and assert no real/global location is touched.

## Blocked by

- Blocked by `kubo-rpc-client` (local RPC + mock API) and `config-resolution` (role, gateways, publisherEndpoint). The publisher/replica record SEQUENCE it hosts is owned by `publisher-replica-model`; the `status` verb reuses `status-report` (both may land in parallel — this task provides only the command surface + warm + the boundary ADR).

## Prompt

> Goal: build the **on-box `pinnace node` subcommands** — the recurring agent loop that runs ON a Kubo node (invoked by cloud-init systemd timers), using the SAME `pinnace` binary the operator uses as a client. Decided architecture (from the follow-up conversation): one codebase, two invocation contexts (client + on-box); this removes the bash/TS behaviour drift the reference prototype had. Read CONTEXT.md (`publisher`, `replica`, `gateway warming`, `core vs cli`).
>
> v1 subcommands under a `node` namespace, each a thin wrapper over core logic against the LOCAL Kubo RPC: `republish` (publisher: `name/publish` refresh + export the signed record via `routing/get`), `mirror` (replica: fetch publisher's record + `routing/put`, fall back to cache), `warm` (auto-discover `/sites/*` from MFS, re-fetch each CID through configured gateways + `.eth` via eth.limo), `status` (regenerate per-site status for the dashboard, reusing the `status-report` core logic). Role-gate republish (publisher) and mirror (replica) on `NODE_ROLE`.
>
> Reference prototypes as the BEHAVIOURAL SPEC (do not emit as bash): `~/searches/ipfs-hetzner/cloud-init.yaml` scripts `ipfs-ipns-publish.sh`, `ipfs-ipns-mirror.sh`, `ipfs-warm.sh`, `ipfs-status.sh` describe exactly what each verb must do. The record export/fetch/put/fallback SEQUENCE itself is owned + tested in `publisher-replica-model`; here you build the command surface it lives in plus `warm` and `status` wiring.
>
> Write a boundary **ADR** in `docs/adr/` (format: `work/protocol/ADR-FORMAT.md`): Kubo owns pinning (`dag/import --pin-roots`) + provider-record freshness (`Reprovider.Interval`); pinnace's recurring on-box loop owns ONLY IPNS republish/export + mirror/fallback + warm + status; the client CLI and the on-box agent are ONE binary. A future reader WILL wonder why there's an on-box CLI when Kubo already pins — the ADR answers that.
>
> Test-first (repo policy on): assert each subcommand dispatches the right core op / Kubo RPC calls against the MOCK Kubo API + fakes, and that role-gating skips the wrong-role verbs. ISOLATE any on-box paths (dashboard/cache) to temp fixtures. Done means the four `pinnace node` verbs exist, role-gate correctly, and the boundary ADR is written.
