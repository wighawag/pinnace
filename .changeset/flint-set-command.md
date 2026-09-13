---
"pinnace": minor
---

Add `pinnace set <id>` — change a live site's metadata (mode, ensName, keep) without rebuilding or re-placing its content

A site already deployed in `ipfs` mode can now be promoted to `ipns` (or get an `ensName`, or a retention policy) in one command, using the content CID the nodes already hold:

```sh
pinnace set --set-mode ipns --set-ens-name mysite.eth mysite
```

It reads the site's current content CID from MFS, writes the resolved `metadata.json`, applies the site's `keep` policy, and in `ipns` mode publishes the IPNS record pointing at that existing CID. No CAR is built and no content is imported or re-placed. The same mode/ensName/keep flags as `deploy` and `pin` apply, resolved the same way (stated > stored > default; omitting preserves).

Because it places no content, it is stricter than `deploy` about what it will infer: it REFUSES when the publisher does not hold the site, rather than resolving a preserved `mode` to the `ipfs` default and writing that demotion to the nodes that do hold it. It also reports the publisher's CID (the one the name resolves to) and names any node holding a different build, since `set` cannot fix that.

Also adds `readSiteContentCidForWrite` / `SiteContentUnreadableError` to the library surface: the content-side twin of the existing strict metadata read, so a node that will not answer is never reported as a node that does not have the site.
