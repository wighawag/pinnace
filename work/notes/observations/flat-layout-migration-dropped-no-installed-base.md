# Flat-layout migration (spec story 8) dropped: no installed base

2026-07-26, resolved during the `sites-metadata-in-mfs` drive.

The review of `mfs-site-wrapper-layout-and-metadata-seam` flagged that spec story 8 (migrating sites from the old flat `/sites/<id>` = content-CID layout to the wrapper layout) had no task covering it, and that the migration path was thinner than the spec implied:

- a plain re-`deploy` over an existing FLAT `/sites/<id>` succeeds silently (`files/mkdir --parents` on the existing content dir, then `cp` into `<id>/content`), leaving the previous site tree as garbage inside the new wrapper;
- `site remove` of a not-yet-migrated flat site can no longer resolve a content cid, so it removes the MFS entry but reports `unpinned: false` and leaks the pin.

**Decision (human, 2026-07-26): drop story 8 entirely.** Nobody uses pinnace, so there is no flat-layout installed base to protect and the story defends a population of zero. Both consequences above are accepted as-is; no migration code, docs or tests are owed. Story 8 is struck through in the spec and the Out of Scope section now excludes flat-layout handling outright rather than merely excluding its automation.

If an installed base ever appears, migration is a FRESH spec written against the reality of that base, not a revival of this story.

Closes the corresponding nit in `review-nits-mfs-site-wrapper-layout-and-metadata-seam-2026-07-25.md`.
