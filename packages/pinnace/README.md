# pinnace

Self-host a static website on IPFS across one or more self-owned Kubo nodes, without a paid pinning service. `pinnace` provisions the nodes (generated cloud-init), deploys your site as a content-addressed archive pinned on every node with the same CID, manages mutable `ipns://` names via a master-key-derived per-site key, keeps public-gateway caches warm, and emits CI, all over the nodes' bearer-guarded Kubo RPC API. Hetzner is the first host; other hosts sit behind a provider seam.

`pinnace` is both a **CLI** and a **library**: the core owns all logic and the `pinnace` bin is a thin wrapper, so every operation is equally usable as a TypeScript API.

## Install

```sh
npm install -g pinnace
# or, per-project:
npm install pinnace
```

Requires Node >= 22.

## Mental model

- **node** (box): a self-owned server running the Kubo IPFS daemon, reached ONLY via its Kubo RPC API (`POST /api/v0/...`, bearer-token guarded, fronted by Caddy over HTTPS). Swarm port 4001 is open so public gateways can dial it; the raw RPC (5001) is never exposed.
- **publisher / replica**: exactly one **publisher** per shared IPNS name holds the derived key, signs + refreshes the record, and exports the raw signed record. Keyless **replicas** pin the same CID and re-announce the publisher's record (falling back to a cached copy if the publisher is down). This is the failover model: the name stays resolvable within the record's validity window even if the publisher dies.
- **CID / CAR**: your site is built client-side into a CAR (Content Addressable aRchive) whose root is the site's UnixFS directory; the same CAR is imported into every node so they all serve the identical **CID**.
- **master key -> per-site IPNS key**: one operator-held secret (env-only, never on a node, never in the config file) deterministically derives each site's IPNS key: `HKDF-SHA256(master, info = "pinnace:ipns:v1:" + id)` -> ed25519 seed -> the `k51...` IPNS name. Names are recoverable from the master alone; provisioning is stateless. This is a frozen contract (see the ADRs).
- **site `id`**: one value per site, used as BOTH its MFS entry (`/sites/<id>`) AND the key-derivation input. Pick anything stable (e.g. `mysite`, or `ronan.eth`).
- **mode**: `ipfs` (land + pin + MFS only; you point a contenthash at `ipfs://<cid>` per deploy) or `ipns` (also publish/refresh; point it at `ipns://<id>` once). Per site for `deploy`, and per pin for `pin` (`--mode ipns` gives an externally-pinned CID your own stable name too).
- **gateway warming**: re-fetching each site's CID through public gateways so their caches stay hot; sites are auto-discovered from MFS.

## Configuration + secrets

Every setting resolves **CLI arg > exported env > `.env.local` > `.env` > `pinnace.json`**.

On startup the `pinnace` bin auto-loads `.env` then `.env.local` from the current directory into the environment (via `ldenv`), so a global install (`npm install -g pinnace`) picks up your secrets with no wrapper: just drop them in `.env.local` and run `pinnace …`. Loading is silent and cwd-only (never a home/global location), and it only AUGMENTS the environment: a value you exported explicitly still wins over the file (`.env.local` overrides `.env`, both sit below an exported var and above `pinnace.json`).

`pinnace.json` holds only NON-secret structure (commit-safe):

```json
{
  "hosts": [
    { "name": "publisher", "endpoint": "https://ipfs-publisher.example.com", "role": "publisher" },
    { "name": "replica", "endpoint": "https://ipfs-replica-01.example.com", "role": "replica",
      "publisherEndpoint": "https://ipfs-dash.example.com" }
  ],
  "sites": [
    { "id": "mysite", "mode": "ipns", "sourceDir": "./site" }
  ]
}
```

Secrets are **env-only, never in the config file** (structurally: the resolver has no file path for them). Each host's bearer token is read from `PINNACE_HOST_<NAME>_TOKEN` (the name upper-cased), and the master from `PINNACE_MASTER`:

```sh
# .env.local (git-ignored) — the ONLY place secrets live; auto-loaded from cwd
PINNACE_MASTER=<your high-entropy master secret>
PINNACE_HOST_PUBLISHER_TOKEN=<publisher bearer token>
PINNACE_HOST_REPLICA_TOKEN=<replica bearer token>
```

This `.env.local` is loaded automatically from the directory you run `pinnace` in (no `export` needed); an explicitly exported value still takes precedence over it. A missing token fails loud (naming the exact env var), never a silent empty token. Point the CLI at a config anywhere with `--config <path>`.

## The end-to-end setup

The full flow, from zero to a redundant, failover-capable IPNS site. Values below match the config above; substitute your own domains.

### 1. Pick tokens + an id

```sh
export PINNACE_HOST_PUBLISHER_TOKEN=$(openssl rand -hex 32)
export PINNACE_HOST_REPLICA_TOKEN=$(openssl rand -hex 32)
# choose one id for the site, used as both the MFS entry and the key input
```

### 2. Generate cloud-init for each box

`provision` emits ready-to-paste cloud-init to stdout (it is per-box and arg-driven; it does not read `pinnace.json`). Give the publisher a `--dashboard-domain`: that vhost serves the exported IPNS records at `/records/` for replicas to fetch.

```sh
# publisher
pinnace provision --host hetzner --role publisher \
  --api-domain ipfs-publisher.example.com \
  --dashboard-domain ipfs-dash.example.com \
  --acme-email you@example.com \
  --bearer-token "$PINNACE_HOST_PUBLISHER_TOKEN" > cloud-init-publisher.yaml

# replica (points at the publisher's DASHBOARD as its records endpoint)
pinnace provision --host hetzner --role replica \
  --api-domain ipfs-replica-01.example.com \
  --acme-email you@example.com \
  --bearer-token "$PINNACE_HOST_REPLICA_TOKEN" \
  --publisher-endpoint https://ipfs-dash.example.com > cloud-init-replica.yaml
```

The emitted cloud-init stands up a hardened node: Kubo as a systemd unit (discoverability tuned so gateways find it), ufw opening 4001 TCP+UDP + 80/443 (never 5001), Caddy HTTPS + bearer API proxy, and it installs a pinned `pinnace` on the box and schedules the on-box agent (`pinnace node republish|mirror|warm|status`) on role-gated systemd timers. The publisher's `republish` timer exports signed records to the dashboard's `/records/`; the replica's `mirror` timer fetches + re-announces them, falling back to cache on outage.

### 3. Create the boxes + DNS

Create two servers (e.g. Hetzner Debian 13 / CX22), each with its `cloud-init-*.yaml` as user-data. Then point DNS at their IPv4s so Caddy can obtain certificates:

```
A  ipfs-publisher    <publisher IP>
A  ipfs-replica-01   <replica IP>
A  ipfs-dash         <publisher IP>     # the records/dashboard vhost
```

Verify each API answers once DNS + certs are up (bearer required):

```sh
curl -sS -X POST https://ipfs-publisher.example.com/api/v0/id \
  -H "Authorization: Bearer $PINNACE_HOST_PUBLISHER_TOKEN"
```

### 4. Derive the IPNS id (optional, before first deploy)

Print a site's `k51...` id from the master + id with no deploy or network, so you can set a contenthash ahead of time:

```sh
pinnace --config pinnace.json derive mysite
```

### 5. Deploy + provision the publisher key

```sh
# build one CAR, import the same CID into every node, place it in MFS
pinnace --config pinnace.json deploy --mode ipns ./site mysite

# import the derived key onto the publisher (and flip its role to publisher)
pinnace --config pinnace.json promote mysite --host publisher
```

After this the on-box timers run the failover loop automatically: the publisher re-signs + exports the record, replicas mirror + re-announce it, and if the publisher goes down the replicas keep the name alive from their cached record within its validity window.

### 6. Check it

```sh
pinnace --config pinnace.json status                 # per-site CID / IPNS id / announce / gateway-serves
curl -sS https://ipfs-dash.example.com/records/mysite.ipns-record   # the exported signed record
```

## Command reference

| Command | What it does |
| --- | --- |
| `pinnace provision --host hetzner --role <publisher\|replica> --api-domain <d> --acme-email <e> --bearer-token <t> [--dashboard-domain <d>] [--publisher-endpoint <url>]` | Emit a node's cloud-init YAML to stdout. |
| `pinnace deploy [--mode ipfs\|ipns] <dir> <id>` | Build one CAR, import the same CID into every configured node, pin + place in MFS; in `ipns` mode publish on the publisher. |
| `pinnace pin <cid> --as <name> [--mode ipfs\|ipns] [--host <name>] [--no-recursive]` | Fetch + pin an EXTERNAL network CID (content you only have the CID for) on every configured node, tracked in MFS at `/sites/<name>` so it is warmed and shows in `status`. With `--mode ipns` it ALSO publishes the pinned CID under YOUR master-derived key on the publisher, so you get a stable `ipns://<id>` pointer to content you mirror (re-pin a newer CID under the same `--as <name>` and the name follows). Needs the content to be retrievable at pin time; `pin/add` blocks while Kubo fetches. Remove it again with `pinnace site remove <name>`. |
| `pinnace promote <id> [--host <name>]` | Derive the per-site key from the master and import it onto the host, making it the publisher (also the replica-promotion path). |
| `pinnace derive <id>` (alias `ipns-id`) | Print a site's `k51...` IPNS id from master + id, no deploy/network. |
| `pinnace status` | Per-site report across nodes: CID, IPNS id, network-announce, gateway-serves. |
| `pinnace install-ci --system github --build-command <c> --output-dir <d>` | Emit a deploy CI workflow and report the secrets/vars to set. |
| `pinnace site <list\|add\|remove> ...` | Manage the sites a node serves (MFS entries + pins). |
| `pinnace node <republish\|mirror\|warm\|status>` | The on-box agent verbs (run by the box's systemd timers; role-gated). |

Global: `--config <path>` selects the `pinnace.json` (default `./pinnace.json`); a named-but-missing path fails loud.

## Library use

Every operation is exported from the package core, so the same things are callable as a TypeScript API:

```ts
import {deriveIpnsId, buildCar, resolveConfig, KuboRpcClient} from 'pinnace';
```

## Design notes / decisions

Durable architectural decisions live in [`docs/adr/`](../../docs/adr/) in the repo, notably: the frozen master-key -> IPNS KDF; that client-side key derivation is NOT client-side record signing (the node signs); and the boundary that Kubo owns pinning + provider-record freshness while the same `pinnace` binary runs the recurring on-box loop.

## License

AGPL-3.0-only.
