<p align="center">
	<img src="assets/logo.svg" alt="pinnace" width="300" height="96">
</p>

# pinnace

Self-host a static website on IPFS across one or more self-owned Kubo nodes, without a paid pinning service. `pinnace` provisions the nodes (generated cloud-init), deploys your site as a content-addressed archive pinned on every node with the same CID, manages mutable `ipns://` names via a master-key-derived per-site key with publisher/keyless-replica failover, keeps public-gateway caches warm, and emits CI, all over the nodes' bearer-guarded Kubo RPC API.

It also mirrors content you did NOT build: `pinnace pin <cid> --as <name>` (or `--from-ipns <source>`, which resolves an existing IPNS name first) makes every node fetch and pin it, tracked like any other site, and `--set-mode ipns` republishes it under your own derived key — a one-command migration of someone else's (or your old host's) content onto boxes you own.

It is both a **CLI** (`pinnace`) and a **TypeScript library**: the core owns all logic; the bin is a thin wrapper.

## Getting started

Install `pinnace` as a **dev dependency** of the project whose site you deploy, so the version is pinned in `package.json` and your CI uses the same one:

```sh
npm install --save-dev pinnace     # or: pnpm add -D pinnace
npx pinnace version                # or: pnpm pinnace version
```

Requires Node >= 22. The docs write commands as `pinnace <...>`; run them as `npx pinnace <...>`, or wire a script into `package.json` (e.g. `"deploy": "pinnace deploy ./dist mysite"`).

## Where things live

`pinnace.json` is INFRASTRUCTURE only — your nodes — and it is OPTIONAL:

```json
{
  "hosts": [
    { "name": "publisher", "endpoint": "https://ipfs-publisher.example.com", "role": "publisher" }
  ]
}
```

For a single node you need no file at all: `--endpoint <url>` supplies that node on the command line, with its bearer token still env-only (`PINNACE_HOST_PUBLISHER_TOKEN`, alongside `PINNACE_MASTER`).

```sh
pinnace deploy --endpoint https://ipfs-publisher.example.com --set-mode ipns ./dist mysite
```

A site's own state lives with the site, on the node: MFS holds each one as a wrapper directory `/sites/<id>/{content, metadata.json}`, where `content` is the site's CID and `metadata.json` is its per-site metadata (`mode`, `ensName`), written by `deploy`/`pin` and read back by the node's own loop (it is how the `warm` timer learns a site's `ensName` and how the `republish` timer knows not to sign an `ipfs`-mode site) and by `status`, which reports both. So per-site settings are flags at deploy/pin time (`--set-mode ipfs|ipns`, `--set-ens-name [<name>]`, `--unset-ens-name`), never config entries; omitting a flag preserves what the site already stores.

The full setup guide (mental model, config + secrets, and the end-to-end provision -> deploy -> failover flow) is in the package README:

- **[packages/pinnace/README.md](packages/pinnace/README.md)** — install, configure, provision Hetzner nodes, deploy an `ipns` site, mirror external content with `pin`, and verify failover.
- **[docs/failover.md](docs/failover.md)** — the failover runbook: recovering a name when the publisher dies (the replicas follow a DNS change; the record-sequence check tells you whether the handover took).

Deploying from CI is `pinnace install-ci`: it emits either a whole starter workflow or just the deploy step to paste into the one you already have, with your nodes baked in as literal args and one bearer-token secret per node. Both forms `uses:` the composite action in [`actions/deploy`](actions/deploy/action.yml), which owns the `pinnace deploy --json` call, the step outputs and the job summary, so a generated pipeline cannot drift from the CLI behind it.

## Repository layout

This is a pnpm monorepo.

- `packages/pinnace/` — the published `pinnace` package (CLI + library).
- `actions/deploy/` — the composite GitHub Action every emitted pipeline uses (`wighawag/pinnace/actions/deploy@<ref>`).
- `CONTEXT.md` — the domain glossary (the vocabulary the code and docs use).
- `docs/adr/` — architectural decision records (the frozen KDF, the no-client-signing boundary, the Kubo-owns-pinning boundary).
- `work/` — the on-disk work contract (tasks, specs, notes) this repo is built with.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Every change requires a changeset (`pnpm changeset`). Releases publish to npm via changesets + npm Trusted Publishing (OIDC) on merge of the "Version Packages" PR.

## License

[AGPL-3.0-only](LICENSE).
