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
npx pinnace --help                 # or: pnpm pinnace --help
```

Requires Node >= 22. The docs write commands as `pinnace <...>`; run them as `npx pinnace <...>`, or wire a script into `package.json` (e.g. `"deploy": "pinnace deploy ./dist mysite"`).

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
