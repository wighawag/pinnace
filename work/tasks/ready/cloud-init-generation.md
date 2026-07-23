---
title: Programmatic cloud-init generation behind a HostProvider seam (Hetzner first)
slug: cloud-init-generation
spec: pinnace
promptGuidance.testFirst: true
blockedBy: [scaffold-pinnace-package, node-agent-commands]
covers: [1, 2, 3, 21]
---

## What to build

Generate a node's cloud-init YAML PROGRAMMATICALLY in TypeScript (not the shell `sed`-template prototype), behind a `HostProvider` interface whose first implementation is `hetzner`. `provision` produces a ready-to-paste cloud-init from a host/site/role config. Deploy/publish/status stay host-agnostic (they speak only Kubo RPC); only host-specific provisioning lives behind this seam, so a new host can be added later without touching deploy/publish (user story 21).

The generated YAML must encode the hardened-node invariants from the reference prototype (`~/searches/ipfs-hetzner/cloud-init.yaml`): Kubo as a hardened systemd unit; firewall opens 4001 TCP+UDP and 443, and NEVER exposes 5001 raw; discoverability config (AcceleratedDHTClient, reprovide interval/strategy, `Routing.Type auto`); the Caddy HTTPS + bearer-token API proxy. The role (`publisher`|`replica`) gates which timers effectively run (`NODE_ROLE`).

**The recurring on-box loop is the SAME `pinnace` binary, not bash (decided — see `node-agent-commands`).** Instead of embedding the reference's bash units (`ipfs-warm.sh`, `ipfs-ipns-publish.sh`, `ipfs-ipns-mirror.sh`, `ipfs-status.sh`), the emitted cloud-init INSTALLS `pinnace` on the box and schedules the on-box subcommands (`pinnace node republish`, `pinnace node mirror`, `pinnace node warm`, `pinnace node status`, exact names per `node-agent-commands`) on role-gated systemd timers. This removes the bash/TS behaviour drift the reference had. Kubo still owns pinning + provider-record freshness (`dag/import --pin-roots` + `Reprovider.Interval`); the pinnace timers own only the IPNS republish/export, replica mirror/fallback, gateway warm, and status regeneration.

Test by SNAPSHOTTING the emitted YAML for a given host/site/role config and asserting invariants: 4001 open TCP+UDP, 5001 NEVER publicly exposed, role-gated timers present, discoverability flags set.

## Acceptance criteria

- [ ] cloud-init YAML is generated programmatically in TS behind a `HostProvider` interface; `hetzner` is the first implementation.
- [ ] The seam keeps deploy/publish/status host-agnostic (they call only Kubo RPC); adding a host later needs no change to them.
- [ ] Emitted YAML encodes: hardened Kubo systemd unit; firewall 4001 TCP+UDP + 443, never 5001 raw; discoverability (AcceleratedDHTClient + reprovide + `Routing.Type auto`); Caddy HTTPS + bearer API proxy.
- [ ] The emitted cloud-init INSTALLS `pinnace` on the box and schedules the on-box subcommands (`pinnace node republish`/`mirror`/`warm`/`status`) on role-gated systemd timers — NOT hand-rolled bash. (Kubo owns pinning + reprovide; the pinnace timers own IPNS republish/export, mirror/fallback, warm, status.)
- [ ] `NODE_ROLE` (publisher|replica) is set from config and gates which pinnace timers effectively run (publisher republishes/exports; replica mirrors).
- [ ] Snapshot tests of the emitted YAML assert the invariants (4001 TCP+UDP open, 5001 never publicly exposed, `pinnace` install + role-gated `pinnace node` timers present, discoverability flags set).
- [ ] Test-first: the failing snapshot/invariant tests are written before the generator.
- [ ] Tests cover the new behaviour and write only to their own temp fixtures.

## Blocked by

- Blocked by `scaffold-pinnace-package`, and `node-agent-commands` (the emitted timers schedule its `pinnace node …` subcommands, so their names/shape must exist first).

## Prompt

> Goal: generate a Kubo node's **cloud-init** YAML PROGRAMMATICALLY in TypeScript, behind a `HostProvider` seam whose first implementation is `hetzner` (CONTEXT.md `host provider seam`; spec Implementation Decisions "Provider seams" + "cloud-init generation"). This replaces the shell `sed`-template approach, which was explicitly superseded.
>
> Reference prototypes (PORT the invariants, do NOT copy verbatim): `~/searches/ipfs-hetzner/cloud-init.yaml` (the full hardened node: systemd Kubo unit, ufw firewall opening 4001 tcp+udp + 80/443 but never 5001, AcceleratedDHTClient + Reprovider + `Routing.Type auto`, Caddy HTTPS + bearer API proxy, the dashboard vhost) and `~/searches/ipfs-hetzner/make-cloud-init.sh` (which per-box values are injected). The role (`publisher`|`replica`) is `NODE_ROLE`.
>
> KEY CHANGE FROM THE REFERENCE (decided — see `node-agent-commands` + its boundary ADR): do NOT embed the reference's bash units. Instead the emitted cloud-init INSTALLS the `pinnace` binary on the box and schedules its on-box subcommands (`pinnace node republish`/`mirror`/`warm`/`status`) on role-gated systemd timers. One codebase runs both on the client and on the box; Kubo owns pinning + reprovide, the pinnace timers own IPNS republish/export + mirror/fallback + warm + status. Use the reference bash only as the behavioural spec of WHAT each timer must do, not as code to emit.
>
> Keep the seam clean: only host-specific provisioning lives behind `HostProvider`; deploy/publish/status speak ONLY Kubo RPC and must not depend on it (user story 21: add a host later without touching them).
>
> Test-first (repo policy on): write failing SNAPSHOT tests of the emitted YAML for a host/site/role config, asserting the security invariants — 4001 open TCP+UDP, 5001 NEVER publicly exposed, the `pinnace` install + role-gated `pinnace node` timers present, discoverability flags set. Done means a deterministic generator whose output satisfies those invariants.
