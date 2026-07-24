---
title: ipfs-car / @ipld/car not installed in this workspace; car-build + deploy tests fail on module resolution
date: 2026-07-24
status: open
---

While working on kubo-multipart-file-uploads I noticed `test/car/car-build.test.ts` and `test/deploy/deploy.test.ts` fail with `Cannot find package 'ipfs-car'` / `Cannot find package '@ipld/car'` (both declared in `packages/pinnace/package.json` but absent from `node_modules`). This is an install/environment gap unrelated to the multipart fix (the failures are pure module-resolution, not assertion failures). A `pnpm install` at the workspace root should resolve it.
