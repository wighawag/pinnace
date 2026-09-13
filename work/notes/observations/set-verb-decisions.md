# `set`: a metadata-only verb, and why it REVERSES a documented stance

Recorded because this change adds a top-level verb and overturns a statement
that appeared, identically, in four places: CONTEXT.md's `metadata` glossary
entry, `packages/pinnace/README.md`'s "Change a site's metadata" section,
`placeInMfs`'s JSDoc, and user story 4 of `work/specs/tasked/sites-metadata-in-mfs.md`.
All four said some form of: *there is no separate `update` verb; re-running
`deploy` IS the update.*

## What that stance got right, and the case it did not cover

It was right that metadata must not become a file the operator edits, and right
that a re-`deploy` is the natural carrier for a metadata change **when the
operator is deploying anyway**. Its unstated premise is that the operator still
HAS the build.

The case that broke it: a site is live in `ipfs` mode, the operator wants a
mutable `ipns://` name (so their ENS record stops needing an update per build),
and `./dist` is long gone. Every existing path demanded content they did not
have: `deploy` needs a source dir; `pin` needs a cid, a source IPNS name, or
another site to promote from. The nodes already held the content and the cid;
the only thing that needed to change was `metadata.json` and one `name/publish`.
Rebuilding an unrelated artifact purely to carry a metadata change is a
workaround, not a design.

So `set` is not a fourth way to place content. It is the metadata-only verb,
and the stance above is narrowed rather than abandoned: metadata is still never
a file you edit, and it is still written only by a verb that acts on the site.

## Decisions

### It writes `metadata.json` directly, NOT through `placeInMfs`

`placeInMfs` is the mkdir/rm/cp/write sequence; `set` has nothing to cp. It
therefore does the write itself and re-does exactly ONE of the things
`placeInMfs` wraps around the write: it calls `prunePins`, so `--set-keep` is
APPLIED and not merely recorded.

That was a defect found in review, not a design: the first cut recorded the
policy and pruned nothing, which made `pinnace set --set-keep 0 mysite` exit
0 having unpinned nothing, while `packages/pinnace/README.md` stated the policy
is applied as each write happens. A flag that means nothing is precisely what
this CLI's standing rule forbids.

It deliberately does NOT re-do `nextHistory`: nothing is superseded when the
content cid does not move.

### A preserved `mode` is resolved from a node that PROVABLY holds the site

This is the sharpest difference from `deploy`, and the one that made a
copied-from-deploy default WRONG.

`deploy` resolves a preserved mode from the publisher and falls back to
`DEFAULT_SITE_MODE` (`ipfs`) when the publisher stores nothing. That is correct
there, because for `deploy` "the publisher stores nothing" legitimately means a
FIRST deploy, and the same run then creates the site.

`set` creates nothing, so on this verb that condition never means "first" —
it means DRIFT (the publisher missed a deploy the replicas got, which the
partial-failure contract permits and exits 0 on). Inheriting the default there
produced a real silent-demotion path: the run would resolve `ipfs`, STATE that
resolved mode to every node, overwrite a replica's stored `ipns`, and stop a
live name from being signed — at exit 0, with one FAIL line.

So `set` refuses (`UpdateSiteMissingError`) when the AUTHORITY node does not
hold the site. The authority is the publisher when there is one (it holds the
key and signs the name, so it is the node a preserved mode must be read from),
else the first target, so a publisher-less fan-out still resolves from a node
that really holds the site rather than from a default. There is no third tier in
this verb's mode resolution: stated, or the authority's stored value, and the
authority provably has the site.

### Absence is established POSITIVELY; an outage is never an absence

`readSiteContentCid` swallows every failure into `undefined` — right for
discovery, wrong here, where a refusal and a write hang off the answer. The
first cut used it and reported a down node (or a rotated token) as *"site has no
content; has it been deployed to this node?"*, sending the operator to fix the
wrong thing and breaking CONTEXT.md's Conventions rule that a check which could
not RUN never reports a definitive negative.

Added `readSiteContentCidForWrite` + `SiteContentUnreadableError` in
`site-wrapper.ts`, the content-side twin of the existing
`readSiteMetadataForWrite` + `SiteMetadataUnreadableError`. The walk-up both use
was factored into one `establishMfsPresence`, so the "absence must be proven,
never inferred from a failure" rule now has ONE implementation and cannot drift
between the metadata and content halves of a wrapper.

### The reported `cid` is the AUTHORITY's, and divergence is NAMED

`deploy`'s `cid` is the one built CAR root, identical everywhere by
construction. `set` reads a cid PER NODE and places none, so nodes can
legitimately hold different builds — and the operator reaching for this verb is,
by hypothesis, in a drifted state.

Reporting `ok[0].cid` (the first cut) let a stale replica that happened to sort
first report a cid the published name does not point at, which a CI step reading
`.cid` would then act on. The result now carries the authority's cid (the one a
resolved `ipns` mode just published) plus a `diverged` list naming every node
holding something else, surfaced in both `--json` and the human output. `set`
cannot fix divergence — only `deploy` or `pin --from-site` can — so it says so.

## Considered and rejected

- **Extend `deploy` with an optional source dir.** Makes the CAR build
  conditional and gives one verb two meanings; the refusals differ
  (`deploy` may create, `set` may not), and that difference is exactly where
  the demotion bug lived.
- **Extend `pin` with a `--from-self` source.** `pin`'s contract is fetch + pin,
  and the whole point here is that there is nothing to fetch.
- **Calling it `update` (the name it shipped to `main` under, before release).**
  Rejected on review. In CLI convention (`npm update`, `brew update`, `apt
  update`) it reads first as "update the tool" and second as "update my site's
  CONTENT" — the exact opposite of what this verb does, since content is the one
  thing it never touches. `set` says what happens: it sets stored fields.

  The rename was free: `update` was committed but never published (the last
  release was 0.17.0 and the changeset for this feature was still pending), so
  no version on npm ever carried the old name and no alias is needed. That
  window is why it was worth doing immediately rather than living with it.

- **Putting it in the `site` namespace (`site set`), the reviewer's suggestion.**
  Rejected, though it is the closer fit by SUBJECT (it manages a site's stored
  fields, like `site add`). Every verb in that namespace takes `--host` and acts
  on exactly ONE node (`pickHost` makes `--host` mandatory once a config has
  two), whereas this one fans out to every node and can sign an IPNS name. That
  is `deploy`/`pin`/`prune` shape. Putting a fan-out-and-sign verb under a
  single-node namespace would have created precisely the kind of quiet contract
  mismatch the rest of this note exists to record.

## What it touches

CONTEXT.md (`metadata`, `mode`, `ensName`, `pin`), both READMEs,
`placeInMfs`'s JSDoc, user story 4 of `work/specs/tasked/sites-metadata-in-mfs.md`,
and the `site-wrapper.ts` strict-read seam (now shared by two readers).
