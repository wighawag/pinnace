---
title: the `test/` tree is not typechecked by any script, and a type error has accumulated there
date: 2026-07-26
status: open
---

Noticed while building `config-drop-sites-and-make-optional`: `packages/pinnace/tsconfig.json` has `include: ["src/**/*.ts"]`, so `pnpm build` (tsc) never sees `test/`, and vitest transpiles without typechecking. Running tsc over the test tree by hand surfaces one PRE-EXISTING error (not introduced by that task): the `pinExternal` stub in `packages/pinnace/test/cli/client-commands.test.ts` ("exits non-zero when NO node pinned the content", ~line 809) returns an object with no `mode`, which `PinExternalResult` requires.

Signal, not a fix: a stub that no longer matches the core's result type can silently drift from the contract it is standing in for. Worth deciding whether the acceptance gate should typecheck `test/` too (a second tsconfig, or widening `include` with a separate `noEmit` script).
