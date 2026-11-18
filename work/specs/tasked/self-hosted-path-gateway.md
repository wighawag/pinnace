---
title: Optional self-hosted PATH gateway per node (--gateway-domain), so sites are viewable and dashboard links are self-referencing
slug: self-hosted-path-gateway
promptGuidance.testFirst: true
---

> Proposed. Records intent at creation, NOT maintained. Current truth: `docs/adr/` + the code.

## Problem Statement

Every node already runs a Kubo HTTP gateway, on `127.0.0.1:8080`, and it is never exposed: bound to localhost, never opened in ufw, not fronted by Caddy. Only the bearer-guarded RPC API (`API_DOMAIN`) and the static status dashboard (`DASH_DOMAIN`) are reachable.

So a fully self-hosted pinnace setup still depends on OTHER PEOPLE's infrastructure for the one thing an operator most wants to do: look at their site. Every user-facing path routes through a third party. The dashboard links to `https://<cid>.ipfs.dweb.link/` and `https://<name>.limo/`, the warm loop warms public gateways, and the status probe asks `dweb.link`. The operator owns the content, the pinning, the key and the name, and still cannot click through to their own site on their own box.

That is a gap in the product's own premise (self-host a static website without relying on paid or third-party services), and it makes the dashboard link AWAY from the infrastructure it is reporting on.

## Solution

An OPTIONAL, per-node, PATH-based public gateway, enabled only by a new `provision --gateway-domain <d>` argument.

- **Provided:** cloud-init emits a third Caddy vhost reverse-proxying `127.0.0.1:8080`, sets `Gateway.NoFetch=true` on Kubo, and records the domain in the box's env file so the on-box `status` renderer can emit self-referencing links.
- **Not provided:** NOTHING changes. No vhost, no Kubo gateway config change, the gateway stays localhost-only exactly as today. The feature is absent, not merely unused, so the default security posture is untouched and existing boxes are unaffected.

Both roles can have one: serving is role-agnostic (a replica pins the same CIDs, so a gateway on a replica is free redundancy for viewing). It is per-box and arg-driven, like every other provisioning input, and carries no site data.

## User Stories

1. As an operator, I want to pass `--gateway-domain gw.example.com` when provisioning a node, so that the node serves the content it pins over HTTPS from my own domain.
2. As an operator who does NOT pass `--gateway-domain`, I want the node to behave exactly as it does today (gateway on localhost, never exposed), so that enabling a public surface is always a deliberate act.
3. As an operator, I want my node's gateway to serve ONLY the content my node already holds, so that exposing it does not turn my box into an open proxy for the whole IPFS network.
4. As an operator, I want the status dashboard to link to my OWN gateway for each site, so that I can click through to my site on my own infrastructure instead of a third party's.
5. As an operator, I want the dashboard to keep showing the PUBLIC-gateway health indicator, so that I can still tell whether the wider network can retrieve my site, which is the thing I do not control.
6. As an operator, I want the gateway on a hostname separate from my dashboard, so that content I host cannot script the origin my status page is served from.

## Implementation Decisions

- **PATH gateway only (`https://gw.example.com/ipfs/<cid>`). Subdomain gateways are OUT OF SCOPE** (see Out of Scope for the consequence and the reasoning). This is the decision that keeps the change small: path routing works with the HTTP-01 ACME Caddy already performs, so provisioning needs NO new credentials. A subdomain gateway (`<cid>.ipfs.gw.example.com`) would require a wildcard certificate, hence DNS-01, hence a Caddy DNS-provider plugin and a DNS API token embedded per box, which is a provider-specific credential this project deliberately does not currently need.
- **`Gateway.NoFetch=true` is MANDATORY whenever the gateway is exposed, and is the load-bearing safety decision.** A default Kubo gateway will FETCH any requested CID from the network and serve it, so exposing it publicly creates an open proxy for arbitrary third-party content: bandwidth abuse, disk growth, and legal exposure on the operator's domain and IP. With `NoFetch`, the gateway serves only blocks already in the local datastore (the operator's own pinned sites) and errors otherwise. This is what makes the feature "self-hosting" rather than "running a public gateway", and it must not be presented as a tunable.
- **A SEPARATE hostname from the dashboard.** The gateway must never be mounted under `DASH_DOMAIN` (e.g. as `DASH_DOMAIN/ipfs/`), because hosted site JavaScript would then share an origin with the status dashboard and the exported `/records/`. Distinct vhost, distinct hostname.
- **Self-links are for HUMANS; the health PROBES stay pointed at public gateways.** Probing your own gateway for content you pinned is near-tautological and tells you almost nothing; the existing `dweb.link` probe tests the thing the operator does NOT control (can the network actually retrieve this?). So the dashboard gains a self-referencing LINK per site, and the existing public-gateway indicator stays as the health signal. Do not repoint the probes at the local gateway. (This is the same lesson as `ethLimoServes=true` being a true answer to a useless question: measuring what you control tells you least.)
- **The dashboard knows its own gateway domain from the box's env file**, the same way it already knows `DASH_DOMAIN`, so the renderer stays a pure view fed by the node.
- **OPEN QUESTION for tasking: the client-side CLI `status`.** The on-box dashboard knows the gateway domain; the operator's CLI does not, because `pinnace.json` is infra-only and carries no such field. Either (a) the CLI simply omits self-links (dashboard-only feature, smallest change), or (b) `hosts[].gatewayDomain` is added to the config schema. (b) is legitimate infra rather than site state, so it does not violate the config shrink, but it widens the schema and should be a deliberate choice at tasking time, not assumed.
- **DNS:** the operator must point an A record at the box for the gateway domain, exactly as for the API and dashboard vhosts. The README walkthrough and its DNS table must say so.
- **Glossary impact:** CONTEXT.md currently uses **gateway** to mean "a public gateway we warm and probe". This spec introduces a second, distinct sense (the node's own HTTP gateway). The terms must be pinned apart, or the next author will conflate "gateway warming" with "our gateway".

## Testing Decisions

`provision` is a pure function returning the cloud-init, so test at that seam: with `--gateway-domain` set, the emitted YAML contains the vhost reverse-proxying `127.0.0.1:8080`, sets `Gateway.NoFetch`, and records the domain in the env file; WITHOUT it, the YAML contains NO gateway vhost, no `NoFetch` change, and the gateway address stays localhost (assert the ABSENCE explicitly, since "disabled entirely" is the security-relevant half). Assert the gateway vhost is never emitted under the dashboard hostname. Dashboard rendering is tested at the existing renderer seam: self-links present when a gateway domain is known, absent when not, with the public-gateway indicator unchanged in both cases. Follow the existing version-stable snapshot discipline (inject fixed values; never bake a real version or domain that churns). No live network, no live daemon.

## Out of Scope

- **Subdomain gateways and per-CID origin isolation** (`<cid>.ipfs.gw.example.com`), and therefore wildcard certificates, DNS-01 ACME, and Caddy DNS-provider plugins. CONSEQUENCE, which must be documented rather than hidden: with a path gateway every hosted site shares ONE origin, so JavaScript on one site can read another's `localStorage`/cookies for that hostname. This is acceptable for an operator hosting their own static sites, and is NOT acceptable for hosting untrusted third-party content. If that need arises it is a fresh spec, not an extension of this one.
- Serving a specific site at its own domain via DNSLink.
- Replacing or repointing the warm targets and status probes (they stay public-gateway oriented, deliberately).
- Abuse mitigation beyond `NoFetch`: no denylists, no rate limiting, no bandwidth caps, no access logs/analytics.
- Any change to the RPC API vhost, its bearer model, or the firewall's port policy (4001 + 80/443 only; 5001 and 8080 stay unopened, since the gateway is reached only through Caddy).

## Further Notes

Came out of a session upgrading a live box, where the operator observed that the dashboard's links all point at third-party gateways while their own node sits ready to serve the same content. Related: `work/notes/observations/node-state-belongs-in-mfs-like-site-metadata.md` also touches the provisioning contract, so if both are built the cloud-init/env-file surface should be reconsidered once rather than twice.
