---
title: Publisher / keyless-replica IPNS record machinery (export + mirror + fallback + promote)
slug: publisher-replica-model
spec: pinnace
promptGuidance.testFirst: true
blockedBy: [kubo-rpc-client, config-resolution, node-agent-commands]
covers: [12, 13, 14]
---

## Resolved design (from the follow-up conversation)

Every open question is now DECIDED (they were open at first tasking; the operator resolved them). Build to these, do not re-litigate:

**Acceptance bar for live `routing/get`/`routing/put` failover (the last unknown, now resolved):** this task LANDS on mock-green. The bar is a mock-level assertion of the full export -> fetch -> `routing/put` -> fallback-to-cache SEQUENCE (+ replica-never-signs), against the mock Kubo API + a fake publisher endpoint. IN ADDITION, ship a live failover SMOKE TEST that SELF-SKIPS unless real node endpoints + token are supplied via env (so it never gates the default `verify` and touches no real infra by default) — it exists so the real-daemon run is reproducible the instant infra is available. ACTUALLY EXECUTING that live test against real Hetzner boxes is a separate `humanOnly` follow-up task (`verify-ipns-failover-live`), because it needs real provisioned boxes + DNS + the operator's master key. (This is the honest split the spec asked for: mock proves the sequence now; the live run is human-gated infra work.)


- **Core owns the logic; the box runs the SAME `pinnace` binary.** The publish/refresh/export (publisher) and fetch/`routing put`/fallback (replica) logic lives in the library core and is exposed as **on-box `pinnace` subcommands** (built in `node-agent-commands`). It is NOT a client-driven loop run from the operator's laptop. Cloud-init installs `pinnace` on the box and schedules those subcommands on systemd timers (built in `cloud-init-generation`). This kills the bash/TS behaviour drift the reference had (`ipfs-ipns-publish.sh`/`ipfs-ipns-mirror.sh` become `pinnace node …` invocations).
- **Kubo owns pinning + provider-record freshness** (`dag/import --pin-roots` once + `Reprovider.Interval`); pinnace does nothing recurring for those. pinnace's recurring loop is ONLY the IPNS republish/export, the replica mirror/fallback, gateway warm, and status. See the boundary ADR from `node-agent-commands`.
- **Promote-a-replica-to-publisher (story 14) is a `pinnace` command**, not a bash runbook: import the derived key into the former replica (Kubo `key/import`), flip its role to publisher, within the record's validity window. It reuses the `key-import-publisher` seam.

## What to build

The publisher / keyless-replica IPNS record machinery (spec C-2 model), so a shared IPNS name stays reachable with a grace window even if the publisher dies, implemented as CORE logic surfaced through the on-box `pinnace` subcommands. Exactly ONE publisher per shared name holds the derived key, publishes/refreshes the record (records ~72h validity, refreshed well within it), and EXPORTS the raw signed record (`routing/get`). Keyless REPLICAS hold no key, pin the same CID, fetch the publisher's exported record and re-announce it (`routing/put`), FALLING BACK to their last cached record if the publisher is unreachable. Story 14: promote a replica to publisher (import key, flip role) within the validity window, recovering the name without content downtime.

Test the export -> fetch -> `routing/put` -> fallback-to-cache sequence at the mock Kubo RPC boundary (+ a fake publisher endpoint), asserting the replica NEVER signs and the fallback path re-announces the cached record when the publisher endpoint is unreachable. Also ship the skip-guarded live smoke test described in the Resolved design section (self-skips without real endpoints).

## Acceptance criteria

- [ ] Exactly one publisher per shared name signs/refreshes (records ~72h, refreshed well within validity) and exports the raw signed record.
- [ ] Keyless replicas fetch the publisher's record and re-announce via `routing/put`, and NEVER sign; a test asserts no signing on a replica.
- [ ] Fallback: when the publisher endpoint is unreachable, the replica re-announces its last cached record (with a test for the cache-fallback path).
- [ ] Promote-a-replica-to-publisher (story 14) is delivered as a `pinnace` command (import key + flip role), reusing the `key-import-publisher` seam.
- [ ] The publish/export/mirror/fallback logic lives in the CORE and is the same code the on-box `pinnace` subcommands (from `node-agent-commands`) invoke — no bash reimplementation.
- [ ] LANDS on mock-green: the export/fetch/`routing/put`/fallback sequence is proven at the mock Kubo RPC boundary + a fake publisher endpoint.
- [ ] A live failover smoke test exists that SELF-SKIPS unless real node endpoints + token are supplied via env (it never runs in the default `verify`, touches no real infra by default, and isolates any paths it writes to temp fixtures). Actually running it is the `verify-ipns-failover-live` follow-up task.
- [ ] Test-first: the failing record-sequence tests are written before the implementation.
- [ ] Tests cover the new behaviour with no live network / shared location by default (the live smoke test is opt-in via env and self-skips otherwise).

## Blocked by

- Blocked by `kubo-rpc-client` (`routing/get`/`routing/put` + mock API), `config-resolution` (role + publisherEndpoint), and `node-agent-commands` (the on-box `pinnace` subcommand surface + the boundary ADR this logic is exposed through). Also relates to `key-import-publisher` (which puts the key on the publisher, reused by promote). The `verify-ipns-failover-live` follow-up task is `blockedBy` THIS task (it runs the smoke test this task ships).

## Prompt

> Goal: build the **publisher / keyless-replica** IPNS record machinery (CONTEXT.md `publisher`, `replica`, `IPNS record`; spec "Publisher / keyless-replica model (C-2)" + user stories 12, 13, 14). One publisher per shared name signs/refreshes + EXPORTS the raw signed record (`routing/get`); keyless replicas fetch it and re-announce (`routing/put`), falling back to their last cached record if the publisher is down; a replica can be PROMOTED to publisher (import key + flip role) within the record's validity window.
>
> Reference prototypes (in cloud-init): `~/searches/ipfs-hetzner/cloud-init.yaml` `ipfs-ipns-publish.sh` (publisher: `name publish` + export via `routing get` to the dashboard vhost) and `ipfs-ipns-mirror.sh` (replica: curl the publisher's `/records/<name>.ipns-record`, `routing put`, fall back to cache). PORT the behaviour, do not copy verbatim.
>
> RESOLVED DESIGN (do not re-litigate — see the "Resolved design" section in this file): the publish/export/mirror/fallback logic lives in the CORE and is exposed as on-box `pinnace` subcommands (built in `node-agent-commands`); cloud-init installs `pinnace` and schedules those on timers; Kubo owns pinning + reprovide; promote-a-replica is a `pinnace` command reusing `key-import-publisher`. ACCEPTANCE BAR (resolved): land on mock-green (prove the export->fetch->`routing/put`->fallback sequence + replica-never-signs at the mock boundary), AND ship a live failover smoke test that self-skips unless real endpoints + token are provided via env — actually running it against real boxes is the separate `humanOnly` `verify-ipns-failover-live` task. All questions are resolved; nothing here is `needsAnswers`.

>
> Test at the mock Kubo RPC boundary + a fake publisher endpoint: assert the export->fetch->`routing/put`->fallback-to-cache sequence and that a replica NEVER signs. Test-first. Respect the "no client-side record signing" invariant (spec Out of Scope) — the node signs, the replica only re-announces.
