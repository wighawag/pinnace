---
title: Live IPNS record transport (publisher export -> replica fetch) depends on the dashboard vhost + on-box republish timer, which the default provision does not fully wire
source: 'live run 2026-07-24 against 2 real Hetzner Kubo v0.38.1 nodes (ipfs-publisher.ska.sh + ipfs-replica-01.ska.sh); observed via the record-sequence.live smoke test failing at the replica mirror step (no-record), cross-checked against the emitted cloud-init Caddyfile + record-sequence.ts fetch path'
---

## The record transport, as actually designed

The publisher/replica C-2 model moves a signed IPNS record from publisher to
replica over HTTP:

- **Publisher export:** `republishAndExport` (record-sequence.ts) re-signs via
  `name/publish` and writes the raw signed record to a local `recordsDir` as
  `<id>.ipns-record` (+ `<id>` ipns-id file).
- **Replica fetch:** `mirrorAndReannounce` fetches
  `${publisherEndpoint}/records/${id}.ipns-record` over HTTP, then `routing/put`
  re-announces it; on fetch failure it falls back to its `cacheDir`.

For this to work live, SOMETHING must serve the publisher's exported record at
`${publisherEndpoint}/records/<id>.ipns-record`. In the intended production
topology that is the **dashboard vhost**: the emitted cloud-init configures a
Caddy vhost `${DASH_DOMAIN} { root * /var/www/ipfs-dash; file_server }`, and the
**on-box `pinnace node republish` systemd timer** writes the exported record into
`/var/www/ipfs-dash/records/`. The replica's `publisherEndpoint` is meant to be
that dashboard URL.

## The gap observed live

The live smoke test reached `exported` (publisher signs+exports fine once the
derived key is imported) but then got `no-record` at the replica mirror, because
NOTHING served the record at the publisher URL. Three compounding reasons:

1. **No dashboard vhost.** `provision` was run WITHOUT `--dashboard-domain`, so
   `DASH_DOMAIN=""` and the records/file_server vhost is not configured at all.
   Nothing serves `/records/`.
2. **The on-box `republish` timer is not running.** It requires the `pinnace`
   binary on the box, which is not installed (the package is unpublished 0.0.0 —
   see `cloud-init-pinnace-install-channel`). So even with a vhost, nothing
   populates `/records/`.
3. **The test exports from the operator's laptop to a local temp `recordsDir`,**
   disconnected from the publisher's public URL the replica fetches from. The
   test's own export does not upload the record anywhere the replica can reach.

## Consequences / what this means

- The mock-proven sequence is correct, but the LIVE end-to-end depends on
  infrastructure the default provision does not fully stand up: a dashboard
  domain MUST be set, AND the on-box republish timer (hence the pinnace binary)
  must run to populate `/records/`. Until the pinnace-install channel is fixed,
  the on-box timer cannot run.
- To VERIFY the C-2 failover behaviour before that infra is complete, the
  export->mirror transport must be bridged another way (e.g. serve the exported
  `recordsDir` over a local HTTP server the replica's `publisherEndpoint` points
  at, or upload the record to a fetchable location). This proves the live daemons
  + real IPNS/DHT do the sign/export/re-announce/fallback correctly, independent
  of the on-box dashboard plumbing.

## Follow-ups this implies

- The live smoke test (and `verify-ipns-failover-live`) should either (a) stand
  up the dashboard vhost + on-box timer (blocked on the pinnace-install channel),
  or (b) document/provide a self-contained transport bridge for the export->mirror
  hop so the failover can be verified without the full on-box topology.
- `provision` for a publisher in `ipns` mode arguably SHOULD require (or default)
  a records-serving endpoint, since without it replicas can never mirror — a
  silently-optional `--dashboard-domain` makes a non-working failover setup easy
  to produce (as happened here).
