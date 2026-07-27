<p align="center">
	<img src="https://raw.githubusercontent.com/wighawag/pinnace/main/assets/logo.svg" alt="pinnace" width="300" height="96">
</p>

# pinnace

Self-host a static website on IPFS across one or more self-owned Kubo nodes, without a paid pinning service. `pinnace` provisions the nodes (generated cloud-init), deploys your site as a content-addressed archive pinned on every node with the same CID, manages mutable `ipns://` names via a master-key-derived per-site key, keeps public-gateway caches warm, and emits CI, all over the nodes' bearer-guarded Kubo RPC API. Hetzner is the first host; other hosts sit behind a provider seam.

`pinnace` is both a **CLI** and a **library**: the core owns all logic and the `pinnace` bin is a thin wrapper, so every operation is equally usable as a TypeScript API.

## Install

Install it as a **dev dependency** of the project whose site you deploy: the version is then pinned in `package.json`, your CI uses exactly that version, and nothing depends on a machine-wide install.

```sh
npm install --save-dev pinnace     # or: pnpm add -D pinnace
```

Run the local binary with your package manager's runner:

```sh
npx pinnace version                # or: pnpm pinnace version
```

Every example below writes the command as `pinnace <...>` for brevity; run it as `npx pinnace <...>`, or wire it into `package.json` scripts:

```json
{
  "scripts": {
    "deploy": "pinnace deploy ./dist mysite",
    "status": "pinnace status"
  }
}
```

Requires Node >= 22. (The nodes themselves install `pinnace` globally for their on-box timers, but that is done for you by the generated cloud-init.)

## Mental model

- **node** (box): a self-owned server running the Kubo IPFS daemon, reached ONLY via its Kubo RPC API (`POST /api/v0/...`, bearer-token guarded, fronted by Caddy over HTTPS). Swarm port 4001 is open so public gateways can dial it; the raw RPC (5001) is never exposed.
- **publisher / replica**: exactly one **publisher** per shared IPNS name holds the derived key, signs + refreshes the record, and exports the raw signed record. Keyless **replicas** pin the same CID and re-announce the publisher's record (falling back to a cached copy if the publisher is down), so the name stays resolvable within the record's validity window even if the publisher dies. That window is a GRACE period, not a handover: getting the name signed again beyond it means another box actually signing, and a box's role (`NODE_ROLE`) and a replica's `PUBLISHER_ENDPOINT` are cloud-init env values pinnace cannot change over Kubo RPC. So promoting a replica is today a REPROVISION of that box, not a command.
- **CID / CAR**: your site is built client-side into a CAR (Content Addressable aRchive) whose root is the site's UnixFS directory; the same CAR is imported into every node so they all serve the identical **CID**.
- **master key -> per-site IPNS key**: one operator-held secret (env-only, never on a node, never in the config file) deterministically derives each site's IPNS key: `HKDF-SHA256(master, info = "pinnace:ipns:v1:" + id)` -> ed25519 seed -> the `k51...` IPNS name. Names are recoverable from the master alone; provisioning is stateless. This is a frozen contract (see the ADRs).
- **site `id`**: one value per site, used as BOTH its MFS home (`/sites/<id>/`) AND the key-derivation input. Pick anything stable (e.g. `mysite`, or `ronan.eth`).
- **site wrapper + metadata**: on a node a site IS a small MFS directory — `/sites/<id>/content` (the site's UnixFS root CID) and `/sites/<id>/metadata.json` (its per-site metadata, `{ensName?, mode}`). `deploy` and `pin` write both; the on-box loop and `status` discover sites by listing `/sites/*`, read each site's CID from its `content`, and pick up its metadata from beside it (that is how `warm` learns a site's `ensName`, and how `republish` knows a site stored as `ipfs` must not be signed even if a key for its id happens to be in the keystore). That is why per-site settings do NOT live in `pinnace.json`: the box acts on what it can SEE, and what it sees is MFS.
- **mode**: `ipfs` (land + pin + MFS only; you point a contenthash at `ipfs://<cid>` per deploy) or `ipns` (also publish/refresh; point it at `ipns://<id>` once). One concept, two carriers — per site for `deploy`, per pin for `pin` — and it resolves the same way for both: `--set-mode ipfs|ipns` > the mode STORED in the site's `metadata.json` > `ipfs`. Omitting `--set-mode` therefore PRESERVES, so re-deploying a published site keeps signing its name instead of silently demoting it to `ipfs`; only a site that stores no mode (a first deploy/pin) runs as `ipfs`. There is no `--unset-mode` (mode has no empty state), and a bare or invalid `--set-mode` is a loud refusal, never a guess. The box obeys the STORED mode: the publisher's `republish` timer signs a site stored as `ipns`, skips one stored as `ipfs` (reporting `ipfs-mode`, not `no-key`), and falls back to key presence only for a site that stores no mode at all.
- **`ensName`**: the optional per-site eth.limo warming lever, stored in the same `metadata.json` and written at deploy/pin time (never a config field, never an input to key derivation). Three states, resolved in strict order by the on-box `warm` loop: a non-empty name warms `https://<name>.limo/` (`--set-ens-name <name>`; neither the name nor the id need be `.eth`, and it overrides a `.eth` id); `""` opts out — never warm, even a `.eth` id (`--unset-ens-name`); ABSENT infers the name from a `.eth` id (bare `--set-ens-name` restores that inference by removing the field, and errors loudly if the id is not `.eth`). Omitting both flags leaves the field exactly as it is: a first deploy leaves it absent, so a `.eth`-named site auto-warms eth.limo with no configuration at all, and a re-deploy preserves whatever the site already carries.
- **gateway warming**: re-fetching each site's CID through the configured public gateways so their caches stay hot; sites are auto-discovered from MFS (`/sites/*`, each CID read from its wrapper's `content`), and the eth.limo half is driven by the site's `metadata.ensName` per the rule above. A warm that fails is RECORDED, never raised (a cold gateway must not fail the run), and recorded honestly: each site reports `warmed`, `partly-warmed` (e.g. its CID gateways are hot but `<name>.limo` is not), `warm-failed`, or `nothing-to-warm`.
- **eth.limo origin + freshness**: "`<name>.limo` responds" is not the same as "it is serving YOUR site". `status` reads the `x-ipfs-path` / `x-ipfs-roots` headers of the same probe and reports two INDEPENDENT axes per site. `ethLimoOrigin`: `ours` (the path names this site's IPNS id, or its CID for an `ipfs`-mode site), `foreign (<path>)` NAMING the other name/cid it points at instead (an ENS record left pointing at the publisher you migrated from keeps a site looking green while pinnace republishes an orphaned name), `frozen (<path>)` (an `ipns`-mode site whose ENS holds an immutable `/ipfs/<cid>`: valid today, but it will never follow a future deploy), `unknown (<reason>)`, or `n/a` when the site resolves no ENS name. `ethLimoFreshness`: `current`, `stale (<served cid>)`, `unknown (<reason>)` or `n/a`. **`stale` is normal shortly after a deploy** (IPNS propagation and gateway caching), so it is shown as an attention state, never as a failure. **Honesty:** these axes observe what eth.limo RESOLVED AND SERVED through its own cache — they are NOT a read of the ENS record (pinnace speaks no Ethereum RPC), so they can lag reality and cannot tell a wrong contenthash from a stale gateway cache.

## Configuration + secrets

Every setting resolves **CLI arg > exported env > `.env.local` > `.env` > `pinnace.json`**.

On startup the `pinnace` bin auto-loads `.env` then `.env.local` from the current directory into the environment (via `ldenv`), so a plain `npx pinnace …` (or a `package.json` script) picks up your secrets with no wrapper: just drop them in `.env.local` and run the command. Loading is silent and cwd-only (never a home/global location), and it only AUGMENTS the environment: a value you exported explicitly still wins over the file (`.env.local` overrides `.env`, both sit below an exported var and above `pinnace.json`).

`pinnace.json` holds only NON-secret, INFRASTRUCTURE structure (commit-safe): your nodes. It carries NO site state — a site's identity and its per-site metadata (`mode`, `ensName`) live in that site's MFS wrapper on the node, so there is nothing here to keep in sync by hand:

```json
{
  "hosts": [
    { "name": "publisher", "endpoint": "https://ipfs-publisher.example.com", "role": "publisher" },
    { "name": "replica", "endpoint": "https://ipfs-replica-01.example.com", "role": "replica",
      "publisherEndpoint": "https://ipfs-dash.example.com" }
  ]
}
```

### The config file is OPTIONAL

A single node needs no file at all: `--endpoint <url>` supplies that one node (as the `publisher`) directly on the command line, and its bearer token stays env-only under the usual convention — `PINNACE_HOST_PUBLISHER_TOKEN`.

```sh
export PINNACE_HOST_PUBLISHER_TOKEN=<publisher bearer token>
export PINNACE_MASTER=<your high-entropy master secret>

pinnace deploy --endpoint https://ipfs-publisher.example.com --set-mode ipns ./dist mysite
pinnace status --endpoint https://ipfs-publisher.example.com
```

`--endpoint` is GLOBAL, like `--config`: write it on either side of the verb (`pinnace --endpoint <url> status` and `pinnace status --endpoint <url>` are the same command), but only once. Being the arg tier it REPLACES the file's hosts for that run (so it also narrows a multi-node config to one node); `--host-endpoint.<name> <url>` instead overrides the endpoint OF a host the file declares. `pinnace.json` is a convenience for multi-node / durable setups, not a requirement — and `derive` needs no node, and so no config, at all.

Secrets are **env-only, never in the config file** (structurally: the resolver has no file path for them). Each host's bearer token is read from `PINNACE_HOST_<NAME>_TOKEN` (the name upper-cased), and the master from `PINNACE_MASTER`:

```sh
# .env.local (git-ignored) — the ONLY place secrets live; auto-loaded from cwd
PINNACE_MASTER=<your high-entropy master secret>
PINNACE_HOST_PUBLISHER_TOKEN=<publisher bearer token>
PINNACE_HOST_REPLICA_TOKEN=<replica bearer token>
```

This `.env.local` is loaded automatically from the directory you run `pinnace` in (no `export` needed); an explicitly exported value still takes precedence over it. A missing token fails loud (naming the exact env var), never a silent empty token. Point the CLI at a config anywhere with `--config <path>`.

## The end-to-end setup

The full flow, from zero to a redundant IPNS site that survives a publisher outage for the record's validity window. Values below match the config above; substitute your own domains.

### 1. Pick tokens + an id

```sh
export PINNACE_HOST_PUBLISHER_TOKEN=$(openssl rand -hex 32)
export PINNACE_HOST_REPLICA_TOKEN=$(openssl rand -hex 32)
export PINNACE_MASTER=<your high-entropy master secret>   # every ipns name derives from this
# choose one id for the site, used as both its MFS home and the key input
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

Print a site's `k51...` id from the master + id with no deploy, network, or config file, so you can set a contenthash ahead of time:

```sh
pinnace derive mysite
```

### 5. Deploy

```sh
# build one CAR, import the same CID into every node, place it in the MFS wrapper,
# and publish the name (importing the derived key onto the publisher if it has none)
pinnace --config pinnace.json deploy --set-mode ipns ./site mysite
```

That is the whole first deploy: in `ipns` mode `deploy` PROVISIONS its own key. If the publisher's keystore has no key for `mysite`, the key derived from your master + the site id is imported onto it (never generated on the box, never onto a replica) and the name is published. No separate step is needed for a new site you deploy from your own machine (for a CI-ONLY project, see `authorize` below).

`deploy --set-mode ipns` either produces a working name or fails telling you how to fix it: if the publisher holds no key and no `PINNACE_MASTER` is exported, the deploy REFUSES before writing anything to any node, naming your three options (export the master, run `pinnace authorize`, or deploy with `--set-mode ipfs`). It never lands content and quietly leaves the name on the old CID.

`--set-mode ipns` is stated ONCE: it is written into the site's `metadata.json`, so every later deploy of `mysite` picks it up from there. Later deploys need NO master, because the publisher already holds the key — which is what makes CI deploys (`install-ci`) key-free: they just re-sign the new CID.

After this the on-box timers run the record loop automatically: the publisher re-signs + exports the record, replicas mirror + re-announce it, and if the publisher goes down the replicas keep the name alive from their cached record within its validity window. That is a grace window, not a handover — recovering the name beyond it means reprovisioning a box to sign (see the publisher/replica note above).

### 6. Change a site's metadata (just re-deploy)

A site's metadata is changed by re-running `deploy` (idempotent) — there is no `update` verb and no file to edit. Flags you omit preserve what the site already stores:

```sh
# a plain re-deploy: mode + ensName preserved, so this keeps signing ipns://
pinnace --config pinnace.json deploy ./site mysite

# name the ENS gateway to warm (writes ensName into the site's metadata.json)
pinnace --config pinnace.json deploy --set-ens-name mysite.eth ./site mysite

# opt out of eth.limo warming entirely (writes ensName: "")
pinnace --config pinnace.json deploy --unset-ens-name ./site mysite

# restore inference for a .eth id (drops the field; the id itself is warmed)
pinnace --config pinnace.json deploy ./site ronan.eth --set-ens-name
```

Write the BARE `--set-ens-name` last (or immediately before another `--flag`): it takes an OPTIONAL value, so `--set-ens-name ./site` would read `./site` as the name.

The same four ensName forms, and the same `--set-mode`, apply to `pinnace pin`.

### 7. Check it

```sh
pinnace --config pinnace.json status                 # per-site CID / IPNS id / stored mode + ensName (a `.eth` site that stores none shows the name it warms, marked `(inferred)`) / eth.limo name AND whether it serves, plus whether what it serves is YOURS (`ethLimoOrigin`) and CURRENT (`ethLimoFreshness`) / announce / gateway-serves (a check that could not run reads `unknown (<reason>)`, never `false`)
curl -sS https://ipfs-dash.example.com/records/mysite.ipns-record   # the exported signed record
```

### 8. CI-only setups: `authorize` once, then deploy forever with no master

`deploy` imports the site key itself, but only when it HAS the master — which bootstraps nothing for a project that only ever deploys from CI, where you do not want `PINNACE_MASTER` at all. Run `authorize` ONCE from your own machine instead:

```sh
pinnace --config pinnace.json authorize mysite   # or bare: every site the publisher holds
```

It derives `mysite`'s key from your master and imports it into the keystore of the host your config declares `role: publisher`. From then on CI deploys that name forever, with no master anywhere in the pipeline. It is IDEMPOTENT: the keystore is probed first, so a key already there is reported `already-authorized` and never re-imported — re-running it, or the bare form over every site the publisher holds in MFS, is safe. A named `<id>` does NOT need the site to exist yet, which is the point: authorize before the very first deploy.

`authorize` grants KEY MATERIAL and nothing else. It is not a failover and it changes no role: it does not touch `hosts[].role` in `pinnace.json`, and it cannot touch the box's own `NODE_ROLE` (see the publisher/replica note in the mental model — promotion is a reprovision). It takes no `--host`, because the config already declares which host is the publisher, and it refuses loudly if that config declares zero or several publishers, or if another configured host already holds a key for the site: two nodes signing one name race the record's sequence numbers, so the name would flap between their CIDs.

With `--endpoint <url>` there is no config to read: that flag MINTS a single host named `publisher` with role `publisher`, so you are ASSERTING that this node is the publisher. pinnace cannot verify the claim (a box's real role lives in its cloud-init env, not over Kubo RPC) and, seeing one node, it cannot check for a second signer elsewhere either — exactly as `deploy --endpoint` already works.

## Command reference

| Command | What it does |
| --- | --- |
| `pinnace provision --host hetzner --role <publisher\|replica> --api-domain <d> --acme-email <e> --bearer-token <t> [--dashboard-domain <d>] [--publisher-endpoint <url>]` | Emit a node's cloud-init YAML to stdout. |
| `pinnace deploy [--set-mode ipfs\|ipns] [--set-ens-name [<name>] \| --unset-ens-name] <dir> <id>` | Build one CAR, import the same CID into every configured node, pin + place it in the MFS wrapper `/sites/<id>/{content,metadata.json}`; in `ipns` mode publish on the publisher, importing the master-derived key first if it holds none (and REFUSING up-front, before touching any node, if it holds none and none can be derived). Omitted flags preserve the site's stored `mode`/`ensName`. |
| `pinnace pin <cid> --as <name> [--set-mode ipfs\|ipns] [--set-ens-name [<name>] \| --unset-ens-name] [--host <name>] [--no-recursive]` | Fetch + pin an EXTERNAL network CID (content you only have the CID for) on every configured node, tracked in the MFS wrapper `/sites/<name>/` so it is warmed and shows in `status`. With `--set-mode ipns` it ALSO publishes the pinned CID under YOUR master-derived key on the publisher, so you get a stable `ipns://<id>` pointer to content you mirror (re-pin a newer CID under the same `--as <name>` and the name follows). Needs the content to be retrievable at pin time; `pin/add` blocks while Kubo fetches. Remove it again with `pinnace site remove <name>`. |
| `pinnace authorize [<id>]` | Grant the DECLARED publisher the per-site key derived from your master, so CI can deploy that name with no master (its primary job: run once locally, deploy from CI forever). Bare = every site the publisher holds in MFS; `<id>` = just that site, which need not exist yet. Idempotent (a key already held is reported `already-authorized`, never re-imported). No `--host`: the config says which host is the publisher, and zero/several declared publishers, or another host already holding that key, are loud refusals. It grants key MATERIAL only — it changes NO role and is NOT a failover. |
| `pinnace derive <id>` (alias `ipns-id`) | Print a site's `k51...` IPNS id from master + id, no deploy/network. |
| `pinnace status` | Per-site report across nodes: CID, IPNS id, the site's stored `mode` + `ensName`, the eth.limo name they resolve to AND whether `https://<name>.limo/` actually serves (`ethLimoServes=true/false`, or `n/a` for a site that resolves no name), the two eth.limo mismatch axes below, network-announce, gateway-serves. The three external checks are three-valued: a check that could NOT run prints `unknown (<reason>)` (e.g. `announced=unknown (http 429)`), never `false` — only a check that ANSWERED reports a negative. |
| `pinnace install-ci --system github --build-command <c> --output-dir <d>` | Emit a deploy CI workflow and report the secrets/vars to set. |
| `pinnace site <list\|add\|remove> ...` | Manage the sites a node serves (MFS wrappers + pins). |
| `pinnace node <republish\|mirror\|warm\|status>` | The on-box agent verbs (run by the box's systemd timers; role-gated). |

Global (either side of the command): `--config <path>` selects the `pinnace.json` (default `./pinnace.json`, whose ABSENCE is fine — a named-but-missing path fails loud), and `--endpoint <url>` supplies one publisher node instead of a config file (token still env-only). `--endpoint` may be given only ONCE: repeating it is a usage error rather than a silent pick.

Every node-touching verb (`deploy`, `pin`, `status`, `site`, `authorize`) also accepts, after the verb, `--host-endpoint.<name> <url>` / `--host-token.<name> <t>` (override one configured host).

A flag you type must never mean nothing, and that covers its NAME as well as its value. Any value-taking flag written with NO value (at the end of the line, or immediately followed by another `--flag`) is a usage error naming it, so a mistyped `pinnace deploy --endpoint --set-mode ipns ./dist mysite` refuses instead of dropping the endpoint and quietly deploying to every host in `pinnace.json`. And any flag a verb does not accept is refused too, naming it and listing what that verb does accept, before anything runs: `pinnace pin --from-ipns <src> --as mysite --mode ipns` fails with "`--mode` was RENAMED: did you mean `--set-mode`?" rather than parsing, being read by nobody, and pinning as `ipfs` with no IPNS record published. The two globals above are stripped first, so they are accepted on either side of every command and never reported as unknown.

## Library use

Every operation is exported from the package core, so the same things are callable as a TypeScript API:

```ts
import {deriveIpnsId, buildCar, resolveConfig, KuboRpcClient} from 'pinnace';
```

## Design notes / decisions

Durable architectural decisions live in [`docs/adr/`](https://github.com/wighawag/pinnace/tree/main/docs/adr) in the repo, notably: the frozen master-key -> IPNS KDF; that client-side key derivation is NOT client-side record signing (the node signs); and the boundary that Kubo owns pinning + provider-record freshness while the same `pinnace` binary runs the recurring on-box loop.

## License

AGPL-3.0-only.
