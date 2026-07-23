---
title: In-process CAR build via ipfs-car + files-from-path
slug: car-build
spec: pinnace
promptGuidance.testFirst: true
blockedBy: [scaffold-pinnace-package]
covers: [5, 6]
---

## What to build

The in-process CAR builder in the core: given a site source directory, build a Content Addressable aRchive (CAR) whose root is a real UnixFS directory preserving the site structure (`index.html`, `assets/...`), capturing the root CID authoritatively as the LAST block emitted by the directory encoder (never scraped from any CLI output), then re-encode the CAR header with that root so `dag/import?pin-roots=true` will pin it. This is the default and primary deploy artifact; multipart folder upload is at most a later optional escape hatch and is NOT in scope here.

Add the CAR dependency explicitly as the two npm packages the prototype uses: **`ipfs-car`** (`createDirectoryEncoderStream`, `CAREncoderStream`) and **`files-from-path`** (the `filesFromPaths` function). Honor the prototype bug-fix: `filesFromPaths(["dist"])` already yields SITE-RELATIVE paths (`index.html`, `assets/s.css`) with no wrapping segment, so do NOT strip a leading segment (the prototype had that bug and fixed it).

## Acceptance criteria

- [ ] `ipfs-car` and `files-from-path` (function `filesFromPaths`) are added as explicit dependencies and used in-process (no external CLI, no output scraping).
- [ ] Building a fixture site dir yields a CAR whose ROOT block is a UnixFS directory whose links preserve the structure (`index.html`, `assets/...` at correct paths).
- [ ] The root CID is captured as the last encoder block and re-encoded into the CAR header (so `dag/import?pin-roots=true` pins the root).
- [ ] The CID is deterministic: identical input yields the identical CID across runs (asserted by decoding the root block, not trusting any stdout).
- [ ] No leading path segment is stripped from `filesFromPaths` output (the fixed prototype bug is guarded by a test asserting `index.html` sits at the root).
- [ ] Test-first: the failing CAR-correctness test is written before the implementation.
- [ ] Tests cover the new behaviour (root-is-directory, structure preserved, deterministic CID).

## Blocked by

- Blocked by `scaffold-pinnace-package`.

## Prompt

> Goal: build pinnace's **CAR** (Content Addressable aRchive) builder in-process. Input: a site source directory. Output: a CAR file + its authoritative root CID (the site's UnixFS directory root). This is the default+primary deploy artifact (CONTEXT.md "CAR"; spec Implementation Decisions).
>
> Dependencies (name them explicitly): **`ipfs-car`** (`createDirectoryEncoderStream`, `CAREncoderStream`) and the npm package **`files-from-path`** (its exported function is `filesFromPaths`). Reference prototype: `~/searches/ipfs-hetzner/deploy-car.mjs` — read its CAR-build section. PORT the logic, do not copy verbatim: pipe files through the directory encoder, capture the LAST emitted block's CID as the root (authoritative, NOT scraped from CLI text), buffer blocks, then re-encode with `new CAREncoderStream([rootCid])` so the CAR header carries the root and `dag/import?pin-roots=true` pins it.
>
> Correction to honor (a real bug the prototype found and fixed): `filesFromPaths(["dist"])` ALREADY yields site-relative paths (`index.html`, `assets/s.css`) — do NOT strip a wrapping segment; the CAR root IS the site dir.
>
> Test-first (repo policy on): write the failing correctness test FIRST — decode the built CAR's root block and assert it is a UnixFS directory whose links are `index.html` + `assets/...` at the right paths, and that identical input gives an identical CID. Do not trust stdout; decode the block. Done means a deterministic, structure-preserving CAR whose root pins under `dag/import?pin-roots=true`.
