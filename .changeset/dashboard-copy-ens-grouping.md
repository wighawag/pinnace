---
'pinnace': minor
---

Dashboard: copy-to-clipboard buttons on opaque identifiers + ENS field grouping.

- Each opaque identifier (content CID, IPNS) now has a one-tap **copy** button beside it. The page gains a tiny progressive-enhancement `<script>` (the only client-side JS); without JS the values stay fully visible, selectable, and linked — nothing is lost.
- The four ENS-specific fields (`ens name`, `eth.limo`, `origin`, `freshness`) are now grouped under a small **ENS** subheading, separate from the core fields (`content cid`, `ipns`, `sequence`, `mode`, `announced`, `gateway`).
- The ENS group is shown **only** when the site resolves an ENS name to warm (`ensNameToWarm`). A site that opts out, resolves no name, or comes from a report path that does no resolving shows no ENS group — the four fields are all not-applicable, so showing them was noise without signal.