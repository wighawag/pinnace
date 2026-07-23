---
title: Scaffold the packages/pinnace package (library + bin)
slug: scaffold-pinnace-package
spec: pinnace
blockedBy: []
covers: [1, 20]
---

## What to build

Stand up the empty `packages/pinnace` package inside this pnpm monorepo, modelled on `template-typescript-lib` (ESM, `NodeNext`, strict TS, `tsc` build to `dist`, `vitest`, changesets, `ldenv` for env). The package MUST expose BOTH a library API via `exports["."]` and a `bin` named `pinnace`. This is the foundation every other task builds on: it is a demoable slice on its own (the package installs, builds, and its test suite runs green with at least one trivial passing test), NOT feature work.

The CLI is a thin wrapper over the core (`core vs cli` in CONTEXT.md): create the seam now (an entrypoint module for the library API and a separate `bin` entry that imports from the core), even if both are near-empty stubs. Wire the repo `verify` gate (`pnpm format:check && pnpm build && pnpm test`, per `dorfl.json`) so it passes on the scaffold. Add the changesets tooling and a `changeset status --since=main` style check per CONTEXT.md conventions (every change requires a changeset).

Default license is AGPL-3.0 per repo policy: add the verbatim FSF `LICENSE` text and `"license": "AGPL-3.0-only"` in `package.json`.

## Acceptance criteria

- [ ] `packages/pinnace` exists as a pnpm workspace member, ESM + `NodeNext` + strict TS, building via `tsc` to `dist`.
- [ ] `package.json` declares `exports["."]` (library API) AND a `bin` named `pinnace` (both resolve to built output).
- [ ] The library-core entrypoint and the CLI bin exist as separate modules; the bin imports from the core (thin-wrapper seam established), even if stubbed.
- [ ] `vitest` is wired and at least one test runs and passes; `pnpm build` and `pnpm test` succeed.
- [ ] The repo `verify` command (`pnpm format:check && pnpm build && pnpm test`) passes on the scaffold.
- [ ] Changesets is set up; a changeset is present for this change (per CONTEXT.md conventions).
- [ ] `LICENSE` is the verbatim AGPL-3.0 text and `package.json` has `"license": "AGPL-3.0-only"`.
- [ ] Tests cover the new behaviour (the trivial passing test proving the toolchain works).

## Blocked by

- None — can start immediately.

## Prompt

> Goal: scaffold the single `packages/pinnace` package this whole project lives in. There is NO code yet; this is the first task. Model it on `~/dev/github/wighawag/template-typescript-lib` (read that template for the exact tsconfig/package.json/vitest/changesets wiring): ESM, `NodeNext` module resolution, strict TypeScript, `tsc` build to `dist`, `vitest` for tests, changesets for releases, `ldenv` for reading env.
>
> Domain vocabulary (see CONTEXT.md): the package is BOTH a **library core** (all logic) and a thin **CLI** (`bin` named `pinnace`) that merely calls the core, so the same operations are usable as a TypeScript API via `exports["."]`. Establish that core-vs-cli seam now as two modules, even if each is a near-empty stub.
>
> Where to look: the template repo for wiring; `dorfl.json` for the `verify` command you must keep green (`pnpm format:check && pnpm build && pnpm test`); CONTEXT.md "Conventions" for the every-change-needs-a-changeset rule (wire `changeset status --since=main` into verify as noted there).
>
> Constraints: default license is AGPL-3.0 (verbatim FSF `LICENSE` + `"license": "AGPL-3.0-only"`). Do NOT add any feature logic — subsequent tasks (RPC client, CAR build, key derivation, cloud-init, CI emitter, status, config, deploy, CLI) build on this. Keep the tree building green.
>
> Done means: `pnpm install && pnpm build && pnpm test` all pass, the package exposes `exports["."]` + a `pinnace` bin, and the core/cli seam exists.
