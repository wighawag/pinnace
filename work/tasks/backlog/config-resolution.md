---
title: Config resolution (CLI arg > env via ldenv > pinnace.json), master env-only
slug: config-resolution
spec: pinnace
promptGuidance.testFirst: true
blockedBy: [scaffold-pinnace-package]
covers: [10, 19]
---

## What to build

The config layer in the core that resolves every setting with precedence **CLI arg > env (`ldenv`) > `pinnace.json`**, and a typed `pinnace.json` schema. The config file describes hosts/nodes (endpoint, token, role publisher|replica, publisherEndpoint) and sites (name, mode `ipfs`|`ipns`, keyId, ensName, sourceDir, optional explicit externally-owned key). This is a thin vertical slice: schema -> resolver -> a test proving precedence, usable both from the CLI and as a TS API.

The **master secret is env-only** and MUST never be read from `pinnace.json` (nor written to it): the resolver deliberately has NO file path for the master. Reading env goes through `ldenv`. This is a security invariant, so it is the headline test: assert that even when a `pinnace.json` fixture contains a `master`-like field, the resolver ignores it and only the env value is used.

## Acceptance criteria

- [ ] A typed `pinnace.json` schema covers hosts/nodes (endpoint, token, role, publisherEndpoint) and sites (name, mode, keyId, ensName, sourceDir, optional explicit key).
- [ ] Resolution precedence is CLI arg > env (`ldenv`) > `pinnace.json`, unit-tested across all three layers.
- [ ] The master secret is read ONLY from env (via `ldenv`); a test asserts a `master` field placed in a `pinnace.json` fixture is IGNORED and never surfaces from the resolver.
- [ ] Test-first: the failing precedence/master-isolation tests are written before the implementation.
- [ ] Tests isolate env: they set/override env within the test (temp/scratch values) and do not depend on or mutate the operator's real environment; assert no real config file is read.
- [ ] Tests cover the new behaviour (precedence per layer + master env-only).

## Blocked by

- Blocked by `scaffold-pinnace-package`.

## Prompt

> Goal: build pinnace's **config resolution**. Every setting resolves as **CLI arg > env (`ldenv`) > `pinnace.json`** (CONTEXT.md "config resolution"). Provide a typed `pinnace.json` schema: hosts/nodes carry `endpoint`, `token`, `role` (`publisher`|`replica`), `publisherEndpoint`; sites carry `name`, `mode` (`ipfs`|`ipns`), `keyId`, `ensName`, `sourceDir`, and an optional explicit externally-owned key (the escape hatch from the spec).
>
> Domain vocabulary (CONTEXT.md): the **master key** is one operator-held secret read via `ldenv`, NEVER from the config file — "Read from env via `ldenv`, never from the config file." This is a hard security invariant (a compromised node/config must not leak the master). Make it structurally impossible: the resolver has no file path for the master. Prove it with a test where a `pinnace.json` fixture contains a decoy `master` field and the resolver still only returns the env value.
>
> Test-first (repo policy on): write the failing precedence tests and the master-isolation test first. ISOLATE the environment in tests — set env within the test process/child as appropriate and never read the operator's real `pinnace.json` or real env (WORK-CONTRACT.md shared-write isolation rule; name the `ldenv`/env lever you override and where it is resolved). Done means precedence holds across all three layers and the master is provably env-only.
