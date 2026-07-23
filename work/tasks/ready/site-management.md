---
title: Site management — add / remove / list sites (MFS + unpin on delete)
slug: site-management
spec: pinnace
promptGuidance.testFirst: true
blockedBy: [kubo-rpc-client, config-resolution]
covers: [4, 15]
---

## What to build

First-class site management so an operator can EASILY add, remove, and list the sites a node serves, rather than relying on implicit MFS side-effects. Sites are auto-discovered from MFS `/sites/*` (that is how warming, republish, and status find them), so "manage sites" means managing those MFS entries + their pins:

- **list**: enumerate the sites the node currently serves (MFS `/sites/*`), with each site's current CID (and IPNS id if a key exists).
- **remove**: delete a site — remove its MFS entry (`files/rm /sites/<name>`) AND unpin its content so it stops being served/announced and its storage is reclaimed. Removing a site must also stop it being warmed/republished (it drops out of MFS auto-discovery automatically).
- **add**: the deploy path already lands a site into MFS; expose add as the explicit, discoverable verb (a thin alias/wrapper over deploy's MFS-placement step, or a distinct verb if adding a site without a fresh CAR is meaningful — decide during build and record the choice).

This is a thin vertical slice over the Kubo RPC seam (MFS + pin endpoints), usable both as core API and as a CLI command. It closes the "easy to manage" gap: add a new website, delete an old one, see what's there.

## Acceptance criteria

- [ ] Core + CLI support listing sites (from MFS `/sites/*`) with each site's CID (and IPNS id if present).
- [ ] Removing a site removes its MFS entry AND unpins its content (storage reclaimed; it drops out of warm/republish/status auto-discovery).
- [ ] Adding a site is exposed as an explicit, discoverable verb (its relationship to `deploy` is decided during build and recorded in the done record / an ADR if it meets the bar).
- [ ] Verified against the mock Kubo API: list reads MFS; remove issues `files/rm` + the unpin call; add places into MFS.
- [ ] Test-first: the failing list/remove/add behaviour tests are written before the implementation.
- [ ] Tests cover the new behaviour against the mock Kubo API (no live daemon / no shared location).

## Blocked by

- Blocked by `kubo-rpc-client` (MFS + pin endpoints + mock API) and `config-resolution` (which node/sites). Relates to `deploy-multi-target` (the add path shares deploy's MFS placement) but is not strictly blocked by it — decide during build whether to depend on or alias it.

## Prompt

> Goal: give pinnace first-class **site management** so an operator can easily add / remove / list the sites a node serves. CONTEXT.md: sites are auto-discovered from MFS `/sites/*` (that is how `gateway warming`, IPNS republish, and status find them), so managing sites = managing those MFS entries + their pins.
>
> Verbs (core + thin CLI): **list** (enumerate `/sites/*` with each current CID + IPNS id if a key exists), **remove** (`files/rm /sites/<name>` AND unpin the content so storage is reclaimed and it stops being served/announced/warmed), **add** (expose the deploy MFS-placement as an explicit discoverable verb — decide during build whether it's an alias over `deploy` or a distinct verb, and RECORD that choice in the done record, or an ADR if it meets the bar in `work/protocol/ADR-FORMAT.md`).
>
> This came out of the follow-up conversation: the operator wants site lifecycle (add new / delete old / see what's there) to be easy and explicit, not an implicit MFS side-effect of deploy. Test at the mock Kubo RPC boundary (from `kubo-rpc-client`): list reads MFS, remove issues `files/rm` + unpin, add places into MFS. Test-first (repo policy on). Done means the three verbs work over the mock API and are usable as both core API and CLI.
