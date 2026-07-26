---
title: ADR-0001 cites glossary terms that no longer exist (`CONTEXT.md keyId` / `ENS name`)
date: 2026-07-26
status: open
---

While re-pinning the `CONTEXT.md` glossary for the MFS wrapper model, noticed `docs/adr/0001-frozen-ipns-key-derivation.md` lines 21-22 point at "CONTEXT.md `keyId`" and "CONTEXT.md `ENS name`", but the glossary has defined those as `id` and `ensName` since `config-token-env-only-and-single-site-id` landed. The ADR's frozen DECISION is unaffected (the derivation still takes the site `id` as its sole per-site input and never the ENS name); only its cross-references dangle. Left alone here deliberately, since the task is glossary-only and ADRs are frozen.
