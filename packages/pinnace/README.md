# pinnace

Self-host a static website on IPFS across one or more self-owned Kubo nodes (Hetzner first, other hosts behind a provider seam).

`pinnace` is a TypeScript CLI **and** library: the core owns all logic (build CAR, deploy, derive keys, generate cloud-init, emit CI, report status); the `pinnace` bin is a thin wrapper so the same operations are usable as a TypeScript API.

See `../../CONTEXT.md` for the domain glossary and `../../docs/adr/` for architectural decisions.

## Status

Scaffold. Feature slices are being built as tracer-bullet tasks (see `../../work/tasks/`).

## License

AGPL-3.0-only. See `../../LICENSE`.
