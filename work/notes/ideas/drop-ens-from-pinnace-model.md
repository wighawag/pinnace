---
title: Drop ENS from pinnace's model — pinnace produces an id/CID, ENS is the consumer's job
date: 2026-07-24
---

## The proposal

ENS is NOT pinnace's responsibility. pinnace makes content addressable +
reachable and hands the operator a stable `ipns://<id>` (or `ipfs://<cid>`).
What the operator does with that id — wire it into an ENS contenthash, a DNSLink
TXT record, a bare `ipns://` link, or nothing — is the CONSUMER's concern, not
pinnace's. So ENS should leave pinnace's MODEL entirely.

Owner intent (2026-07-24): "completely drop ENS out of the picture, this is not
the responsibility of pinnace."

## What "ENS" actually is in the code today (two separable things)

1. **ENS as a configured field/concept — `ensName` (DROP this).**
   - `SiteConfig.ensName?: string` (config-resolution.ts) — OPTIONAL and, notably,
     INERT: no operation reads it. A stored-but-unused field.
   - CONTEXT.md has an "ENS name" glossary entry, and the `mode`/`keyId` entries
     explain themselves in ENS terms ("ENS uses ipfs://<cid>", "ipns://<id>").
   - Spec user story 9 = "keyId decoupled from ENS name"; ADR-0001's frozen-KDF
     rationale leans on "operators set their ENS contenthash to ipns://<id>".
   Because the field is inert, removing it breaks no behaviour.

2. **ENS as behaviour — `.eth` -> eth.limo gateway warming (KEEP, reframe).**
   - `pinnace node warm` does `if (site.name.endsWith('.eth')) { warm via eth.limo }`
     (node-commands.ts); provision `DEFAULT_GATEWAYS` mentions eth.limo.
   - This is a real, useful feature and keys off a STRING SUFFIX of the MFS name,
     NOT the `ensName` field — so it is independent of (1). Keep it, but reframe:
     "eth.limo is one configurable public gateway; a `.eth`-suffixed MFS name is
     warmed through it" — a gateway-warming detail, NOT ENS management. (Or drop
     the hardcoded suffix special-case and make it purely config-driven.)

## The change shape

- **Config:** remove `ensName` from `SiteConfig`. The per-site identity is the
  MFS `name` + the frozen `keyId` (and see the sibling observation
  `site-name-and-keyid-default-to-one-id`: for a no-ENS site `keyId` should
  default to `name`, so a user picks ONE id).
- **CONTEXT.md:** remove the "ENS name" glossary entry; re-word `keyId`, `mode`,
  and `gateway warming` to describe pinnace's deliverable as the `ipns://<id>` /
  `ipfs://<cid>` itself, with "wiring that id into ENS/DNSLink/etc. is OUT OF
  SCOPE" stated once.
- **ADR-0001:** re-word the frozen-KDF rationale to stand on "the id is a public,
  hard-to-change identifier operators publish (ENS, DNSLink, direct links)"
  rather than ENS specifically. The frozen-contract reasoning is unchanged; only
  the ENS-specific framing goes.
- **Spec (`specs/tasked/pinnace.md`):** user story 9 and the ENS framing in
  stories 7/22 + the mode bullet need reconciling. This is a SPEC-level reshape:
  per WORK-CONTRACT.md do NOT hand-edit the tasked spec silently — reopen
  `specs/tasked/ -> specs/ready/`, reconcile (drop ENS as a pinnace concern),
  then re-task the affected slice, superseding stale emitted tasks.
- **CI emitter / status / node-commands doc comments:** drop "(often the ENS
  name)" asides; keep behaviour.

## Coordination

- Sibling observation `site-name-and-keyid-default-to-one-id.md` (one ID for a
  no-ENS site) is part of the same simplification — do them together.
- `unify-ipns-key-name-convention` (staged) touches the same key-name surface.

## Why this is an IDEA, not a silent edit

It removes a shipped domain field, rewrites CONTEXT.md + an ADR's rationale, and
contradicts a tasked user story (9). That is a model reshape that must flow
through the spec/tasking lifecycle (reopen -> reconcile -> re-task), not a
runbook-time hand edit. Promote to a spec reconciliation + task when ready.
