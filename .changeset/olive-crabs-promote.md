---
'pinnace': minor
---

Add `pin --from-site <id>`: promote a staging site's current build to the live site.

A site wrapper means "the cid this name resolves to". In `ipfs` mode, where every build has its own address and the ENS record only moves when a human moves it, a pipeline that deploys straight to the LIVE id therefore breaks that meaning on every push: the box warms a cid nobody resolves, `status` reports `freshness=stale` for ever, and the cid the record actually points at becomes UNTRACKED, which would let any future retention policy reclaim the live build.

The fix is a third pin source. CI deploys to a staging id, and a human promotes when they are happy:

```sh
pinnace deploy ./web/build mandalas-staging                   # CI, every push
pinnace pin --from-site mandalas-staging --as mandalas.eth    # you, when ready
```

- The source cid is read from MFS on ONE node and that single cid is fanned out, so an unevenly-landed deploy can never promote two different builds to two boxes. The publisher is read first (its view is the authoritative one, since it is the node that signs names), with the other targets as a reachability fallback so a down publisher cannot block a promotion. The node that answered is reported.
- The destination keeps its OWN metadata: an omitted `--set-mode` / `--set-ens-name` preserves what the DESTINATION stores, never what the source stores, so promoting a plain `ipfs` staging build into a published `ipns` site keeps signing its name.
- Promoting a site onto itself is refused (a no-op dressed as a promotion, and usually a typo for the other id), as is giving more than one source: the `cid` / `--from-ipns` / `--from-site` choice is now enumerated rather than checked pairwise, so a future fourth source cannot create an unchecked combination.
- Rollback falls out for free: `pinnace pin <old-cid> --as <id>` with a cid you already know.

`readSiteContentCid` is exported from the site-management module as the seam this reads through.
