# Failover runbook: the publisher died, now what?

This is the operational procedure for recovering a site's IPNS name when the box that signs it is gone. It is deliberately a RUNBOOK and not a `pinnace` verb: read ["Why this is not one command"](#why-this-is-not-one-command) before wishing it were.

## First: you have about 72 hours, and your content never went down

Two things stay true the moment the publisher dies:

- **The content is fine.** Every replica still pins the same CID and still serves it. Nothing about `ipfs://<cid>` addressing is affected at all.
- **The name keeps resolving for a while.** Records are signed with a 72h lifetime (`RECORD_LIFETIME`), the publisher re-signs every 6h, and replicas re-announce every 3h, falling back to their last cached record when the publisher is unreachable. So the name survives on the last signed record for up to ~72h from the last time it was signed.

You are therefore recovering a NAME inside a three-day window, not fighting an outage. Do it carefully rather than fast.

## The key insight: DNS is already the indirection layer

A replica does not point at the publisher's IP. It points at a URL, its `PUBLISHER_ENDPOINT`, which is the publisher's dashboard vhost (`https://ipfs-dash.example.com`), and it fetches `<PUBLISHER_ENDPOINT>/records/<id>.ipns-record` from it.

That means **you do not have to touch the replicas at all.** Repoint the `ipfs-dash` DNS record at the new publisher and every replica follows automatically, with no SSH, no reprovision, and no config change on any existing box.

This also means the box you promote does NOT have to be a surviving replica. Building a NEW publisher is usually the better move: cloud-init only runs at first boot, so "reprovision a replica into a publisher" would mean destroying a box that already holds all your content.

Precondition: this works only if `PUBLISHER_ENDPOINT` is a DOMAIN you control, not a bare IP. If you provisioned replicas pointing at an IP, they cannot be redirected and you are in the reprovision-the-replicas case, which is much worse. Use a domain.

## The procedure

### 1. Provision a new publisher, with the SAME dashboard domain

```sh
pinnace provision --host hetzner --role publisher \
  --api-domain ipfs-publisher-02.example.com \
  --acme-email you@example.com \
  --bearer-token "$PINNACE_HOST_PUBLISHER_TOKEN" \
  --dashboard-domain ipfs-dash.example.com > cloud-init-publisher-02.yaml
```

Create the box with that as user-data. Give it its own `--api-domain` (it is a different machine), but **the same `--dashboard-domain`**, because that is the name every replica already fetches records from.

### 2. Point DNS at it

```
A  ipfs-publisher-02   <new IP>          # its own API vhost
A  ipfs-dash           <new IP>          # MOVED from the dead publisher
```

Wait for Caddy on the new box to obtain certificates for both names. Until `ipfs-dash` resolves to the new box and serves HTTPS, replicas keep serving from their cached record, which is exactly the grace window doing its job.

### 3. Get the content onto it

The new box is empty. Either re-deploy from source:

```sh
pinnace --config pinnace.json deploy ./site mysite
```

or, if you do not have the source at hand, pin the CID from the surviving replicas (they are providing it):

```sh
pinnace --config pinnace.json pin <cid> --as mysite
```

Omit `--set-mode` in both cases: mode is PRESERVED from the site's stored metadata, so a site that was `ipns` keeps being `ipns`.

### 4. Update `pinnace.json` and grant the key

Point the publisher host entry at the new endpoint and remove (or demote) the dead one, so exactly ONE host is `role: publisher`. Then:

```sh
pinnace --config pinnace.json authorize mysite
```

This imports the master-derived key into the new box's keystore. `deploy` in `ipns` mode does this too when it has the master, so step 3 may already have covered it; `authorize` is idempotent and reports `already-authorized` if so.

### 5. VERIFY THE SEQUENCE NUMBER (do not skip this)

This is the step that decides whether the failover actually took.

```sh
pinnace --config pinnace.json status
```

Read the `seq` field per site, on every host. Among unexpired IPNS records **the highest sequence number wins**, so:

- If the new publisher's `seq` is **equal to or higher** than what the old publisher was at, the handover took.
- If the new publisher's `seq` is **0** (or otherwise below the old one), **the name is still resolving to the OLD CID** and will keep doing so until the old record expires, no matter how healthy everything else looks.
- If `seq` reads `unknown (<reason>)`, the node could not read the record. That is not a pass. It is not a fail either; it means you do not know yet. Retry once the box has DHT peers.

**Why this happens.** Kubo picks the sequence for a new record by looking for the name's existing record, first in its local datastore, then in the routing system. A brand-new publisher misses locally, and if the routing lookup also fails (not found, a network error, or its 30s timeout, all of which are likely on a box that booted minutes ago) Kubo cannot tell that apart from a genuinely new name and **silently starts at sequence 0**. It signs happily, exports a record, replicas mirror it, and every other indicator reads green. See [the finding](../work/notes/findings/ipns-sequence-resets-to-zero-on-a-new-signer.md) for the source-level detail.

**If the sequence is stuck low**, you have two options:

- **Wait.** Once the old record expires (<=72h from its last signing) the new record is the only one left and wins by default. Safe, slow, and the name may resolve to the old CID until then.
- **Publish with an explicit higher sequence.** Kubo accepts a `sequence` argument on `name/publish` and refuses anything not strictly higher than the current record, so it can never silently regress a name. `pinnace` exposes this on the library's Kubo client (`NamePublishOptions.sequence`) but deliberately **not** as a CLI flag: overriding a sequence is how you paper over a split-brain instead of noticing one, so it should be a deliberate act, not a flag people reach for. On the box itself the equivalent is `ipfs name publish --sequence <n> --key <id> /ipfs/<cid>`.

### 6. Decommission the old box, for real

**Destroy it, do not just leave it powered off.** If the old publisher ever comes back holding its keys, two boxes sign the same name, race each other's sequence numbers, and the name flaps between their CIDs. Removing a key over RPC is best-effort by nature (the box is usually down, which is why you are failing over), so it cannot close this. Only taking the machine out of service can.

`authorize` refuses to import a site's key when another CONFIGURED host already holds it, which catches the honest mistake, but it can only see hosts in your config and cannot see a box you forgot about.

## Why this is not one command

Two things block a `pinnace failover` verb today, and only one of them is about ergonomics:

1. **A box's role is not reachable over Kubo RPC.** `NODE_ROLE` and `PUBLISHER_ENDPOINT` are cloud-init env values on the box. pinnace speaks only Kubo RPC (never SSH), so it cannot change what a box believes it is. Moving that state into MFS has been considered and is recorded, with its costs, in `work/notes/observations/node-state-belongs-in-mfs-like-site-metadata.md`.
2. **The sequence hazard above is a property of the failover PRIMITIVE**, not of the ergonomics. Wrapping this runbook in a single confident command before that is solved would produce a failover that silently does not take effect, which is worse than a documented procedure with a verification step in the middle.

The DNS indirection means the procedure is short anyway, and the 72h window means it is never urgent.
