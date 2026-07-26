<p align="center">
	<img src="assets/logo.svg" alt="pinnace" width="300" height="96">
</p>

# pinnace

Self-host a static website on IPFS across one or more self-owned Kubo nodes, without a paid pinning service. `pinnace` provisions the nodes (generated cloud-init), deploys your site as a content-addressed archive pinned on every node with the same CID, manages mutable `ipns://` names via a master-key-derived per-site key with publisher/keyless-replica failover, keeps public-gateway caches warm, and emits CI, all over the nodes' bearer-guarded Kubo RPC API.

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

- **[packages/pinnace/README.md](packages/pinnace/README.md)** — install, configure, provision Hetzner nodes, deploy an `ipns` site, and verify failover.

## Repository layout

This is a pnpm monorepo.

- `packages/pinnace/` — the published `pinnace` package (CLI + library).
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
