# On-box agent boundary: Kubo owns pinning + reprovide, pinnace owns the IPNS/warm/status loop, one binary

**Status:** accepted

A future reader will look at `pinnace node <verb>` and reasonably ask: *why is there an on-box CLI loop at all when Kubo already pins content and keeps its own provider records fresh?* This ADR records the boundary so that question has a durable answer, and so nobody "simplifies" by folding pinnace's recurring work into Kubo config (it can't) or by re-splitting the codebase into a separate on-box agent (we deliberately don't).

## The boundary (what owns what)

- **Kubo owns content availability.** Pinning is a ONE-TIME `dag/import --pin-roots` at deploy; after that Kubo keeps the CID pinned and re-announces its provider records on its own schedule (`Reprovider.Interval`, plus AcceleratedDHTClient + delegated routing). pinnace does **nothing recurring** for pinning or provider-record freshness. There is no pinnace timer that re-pins or re-provides.
- **pinnace's recurring on-box loop owns ONLY what Kubo does NOT do for us:**
  - **IPNS republish + export** (`pinnace node republish`, publisher role) — Kubo does not refresh an IPNS record's *validity* on its own; refreshing requires re-signing (`name/publish`) with the key, and the raw signed record must be **exported** (`routing/get`) for keyless replicas to mirror.
  - **replica mirror + fallback** (`pinnace node mirror`, replica role) — a keyless box fetches the publisher's exported record and re-announces it (`routing/put`), falling back to its last cached record if the publisher is unreachable. Kubo has no notion of "mirror another node's IPNS record."
  - **gateway warm** (`pinnace node warm`) — re-fetching each site's CID through public gateways (dweb.link, ..., and eth.limo for `.eth` names) to keep their caches hot. This is external cache warming, wholly outside Kubo.
  - **status** (`pinnace node status`) — regenerating the per-site dashboard report (CID / IPNS id / announce / gateway-serves), reusing the `status-report` core logic.

The record SEQUENCE that `republish`/`mirror` host (export -> fetch -> `routing/put` -> fallback) is owned and tested by `publisher-replica-model`; the per-site checks `status` reuses are owned by `status-report`. This ADR fixes only the *boundary*, not those internals.

## The client CLI and the on-box agent are ONE binary

The operator's client (`pinnace deploy`, `pinnace status`, ...) and the box's periodic agent (`pinnace node republish|mirror|warm|status`, invoked by cloud-init systemd timers) are the **same `pinnace` binary running the same core logic** in two invocation contexts. The record/warm/mirror/status logic therefore has a **single implementation**.

## Why (the trade-off)

The reference prototype implemented the on-box loop as bash scripts (`ipfs-ipns-publish.sh`, `ipfs-ipns-mirror.sh`, `ipfs-warm.sh`, `ipfs-status.sh`) baked into cloud-init, while the client tooling was TypeScript. That is two implementations of the same behaviour (record export/fetch/put/fallback, MFS site discovery, gateway warming, status shape) that **drift**: a fix or a semantics change on one side silently diverges from the other. Collapsing both onto one binary removes that drift class entirely at the cost of shipping the `pinnace` binary onto the box (cloud-init installs it and schedules `pinnace node …` on timers instead of emitting shell). We accept that cost because behavioural correctness of the IPNS grace-window machinery matters more than avoiding one binary on the box.

## Consequences

- Cloud-init (built in `cloud-init-generation`) installs `pinnace` and writes systemd units that call `pinnace node <verb>`; it no longer emits the four bash scripts.
- Because `republish` (publisher) and `mirror` (replica) self-gate on `NODE_ROLE` (skipping cleanly, touching no Kubo RPC, when the role doesn't match), scheduling **all** timers on **every** box is safe — the wrong-role verb is a no-op.
- The `node` namespace reuses the domain noun **node** (a.k.a. box) deliberately: `pinnace node <verb>` means "the verbs that run ON a node", distinct from the operator's client verbs. It is a namespace for invocation-context, not a new domain concept.
