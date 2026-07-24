---
title: Drop ENS from pinnace's model — pinnace produces an id/CID, ENS is the consumer's job
date: 2026-07-24
---

## The proposal (refined 2026-07-24)

ENS is not pinnace's IDENTITY concern (that is the `id` = name + keyId), and
setting the ENS contenthash is NOT pinnace's job (pinnace hands you the
`k51...` / `cid`; wiring it into ENS/DNSLink/a bare `ipns://` link is the
consumer's concern). BUT ENS has ONE legitimate, useful role in pinnace: as an
OPTIONAL per-site field that unlocks **eth.limo gateway warming**. So ENS does
not leave entirely — it is DEMOTED from a core/identity concept to an optional
warming hint.

Three roles, sorted out:
1. **Identity** -> the `id` (name + keyId, collapsing to one ID). ENS plays NO
   part. Drop ENS here.
2. **Warming** -> ENS is an OPTIONAL per-site field: "this site is also published
   under `ronan.eth`, so ALSO warm it through eth.limo." Opt-in, does one
   concrete thing. KEEP ENS here.
3. **Contenthash wiring** (setting the ENS record) -> NOT pinnace's job. Out of
   scope.

Owner intent (2026-07-24): "drop ENS out of the picture, this is not the
responsibility of pinnace" AND "the warming part is useful, that is where ENS can
be used, as optional field associated to a site."

## What "ENS" actually is in the code today (two separable things)

1. **ENS as an IDENTITY concept (DROP this framing).**
   - CONTEXT.md has an "ENS name" glossary entry, and the `mode`/`keyId` entries
     explain themselves in ENS terms ("ENS uses ipfs://<cid>", "ipns://<id>").
   - Spec user story 9 = "keyId decoupled from ENS name"; ADR-0001's frozen-KDF
     rationale leans on "operators set their ENS contenthash to ipns://<id>".
   Re-word all of this so pinnace's deliverable is the `ipns://<id>` / `ipfs://<cid>`
   itself, and ENS is not part of the identity model.

2. **The `.eth`-suffix warming HEURISTIC (fix this — the real design bug).**
   - `pinnace node warm` does `if (site.name.endsWith('.eth')) { warm via eth.limo }`
     (node-commands.ts). This keys eth.limo warming off the MFS ENTRY NAME's
     suffix, which COUPLES identity to ENS: it forces a user who wants eth.limo
     warming to name their `/sites/<name>` entry `*.eth`. Wrong coupling.
   - FIX: replace the suffix heuristic with the EXPLICIT optional `ensName`
     field. Warm via eth.limo when `ensName` is set (`https://<ensName>.limo`),
     decoupled from what the MFS entry is called. ENS becomes a pure, opt-in
     warming hint — strictly better than both the suffix magic and dropping ENS.

3. **`SiteConfig.ensName` (KEEP — but give it a JOB).**
   - Today `ensName?: string` is OPTIONAL and INERT (no operation reads it).
   - After this change it becomes the LEVER for (2): present => also warm eth.limo.
     So it stops being a stored-but-unused field and does exactly one thing.

## The change shape

- **Config:** KEEP `ensName?: string` on `SiteConfig` but repurpose it as the
  OPTIONAL eth.limo-warming hint (present => also warm `https://<ensName>.limo`).
  It is NOT part of identity: the per-site identity is the MFS `name` + frozen
  `keyId` (and see the sibling observation `site-name-and-keyid-default-to-one-id`:
  for the common case `keyId` defaults to `name`, so a user picks ONE id).
- **Warming:** replace `name.endsWith('.eth')` in `pinnace node warm` with a
  check on the explicit `ensName` field, so eth.limo warming is decoupled from
  the MFS entry name. Keep eth.limo in the configurable gateway set.
- **CONTEXT.md:** remove the identity-level "ENS name" glossary framing; re-word
  `keyId` and `mode` so pinnace's deliverable is the `ipns://<id>` / `ipfs://<cid>`
  itself, and "wiring that id into ENS/DNSLink is OUT OF SCOPE" is stated once.
  Reframe `ensName` (in `gateway warming`) as the optional eth.limo-warming hint.
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

It repurposes a shipped domain field, replaces a behavioural heuristic, rewrites
CONTEXT.md + an ADR's rationale, and contradicts a tasked user story (9). That is a model reshape that must flow
through the spec/tasking lifecycle (reopen -> reconcile -> re-task), not a
runbook-time hand edit. Promote to a spec reconciliation + task when ready.
