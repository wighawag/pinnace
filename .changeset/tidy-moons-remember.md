---
'pinnace': minor
---

Remember superseded builds, and add opt-in retention: `--set-keep <n>` and a `prune` verb.

`deploy` and `pin` replaced a site's content and pinned the new root, but never accounted for the old one. Every re-deploy left an ORPHAN pin: content the node keeps for ever, that no site references, that `status` cannot see, and that no pinnace verb could reclaim (the only handle left was a raw Kubo `pin/rm`). In `ipfs` mode that is one orphan per push.

The fix is deliberately two halves, with different defaults:

- REMEMBERING is automatic. A write that changes a site's content records the superseded cid in that site's own `metadata.json` (`history`, most recent first), which is what makes it accountable at all, and makes rollback a normal command: `pinnace pin <old-cid> --as <id>`.
- FORGETTING is opt-in, per site: `--set-keep <n>` / `--unset-keep` on `deploy` and `pin`, stored in the metadata and PRESERVED when omitted, exactly like `--set-mode` and `--set-ens-name`. An absent policy means KEEP EVERYTHING, because pinnace cannot read an ENS record: it knows what a gateway served, never what a contenthash says, so it can never prove an old cid is unreferenced, and a default retention would eventually unpin a live site.

The new `pinnace prune <id> [--keep <n>] [--apply] [--host <name>]` applies a policy on its own, across every node. It is a DRY RUN until `--apply`, and the dry run performs every read and every check, so its report is what a real run would do rather than an estimate. A site with no stored policy and no `--keep` is refused, not guessed.

Two invariants hold on every path:

- Nothing is unpinned that another site currently resolves to. A Kubo recursive pin is not reference-counted, and sites SHARE cids routinely (promoting a staging build with `pin --from-site` leaves two sites on one cid; a rollback re-points a site at a cid still in its own history), so the guard reads every site's current content before unpinning anything, and refuses outright if it cannot list them. A cid skipped this way is reported and stays listed, because it is still held.
- A cid leaves the history only once it has actually been unpinned, so a failed unpin is retried by the next prune instead of being forgotten while still occupying disk.

Unpinning only makes blocks eligible for collection; the space comes back on Kubo's own `repo gc`, which pinnace still never triggers on your behalf. The verb says so rather than leaving you wondering why the disk did not move.

Two behaviour changes worth knowing about, both in the write path: a placement now reads the site's current content cid first (that is the superseded cid), and a fully-stated write (`--set-mode` plus `--set-ens-name`/`--unset-ens-name`) now also makes ONE tolerant metadata read to carry `keep`/`history` forward. That read cannot refuse a write: neither field is an addressing decision, and losing `keep` fails safe (back to keeping everything), so the existing "a fully-stated write gets past a node whose MFS cannot be read" property is preserved.
