# `republish` is the one reader that does NOT read an ABSENT mode as `ipfs`

2026-07-26, while building `onbox-republish-and-status-consume-metadata`.

Everywhere else in pinnace an absent stored `mode` means `ipfs` (`DEFAULT_SITE_MODE`, the write-side resolver, and the CONTEXT.md `mode` glossary entry: "absent simply means `ipfs`"). The on-box `republish` deliberately does NOT apply that default: a site whose `metadata.json` stores no `mode` falls back to today's key-presence rule, so it still gets signed and exported when a key for its id exists. The task (`onbox-republish-and-status-consume-metadata`) mandates this tier explicitly and calls it load-bearing, because applying the `ipfs` default there would silently stop republishing every live site placed before metadata existed, i.e. turn a back-compat gap into a name outage.

So the divergence is intentional, but it does mean "absent means `ipfs`" is now true of every WRITE path and false of this one READ path. Recorded here (and in `republishAndExport`'s JSDoc + the CONTEXT.md `mode` entry) so a human can ratify it rather than discover it. If it is ever reversed, the reversal is a one-line change in `src/publisher/record-sequence.ts` plus its back-compat tests, and it should be paired with a real migration story for mode-less sites (there is none today, and spec `sites-metadata-in-mfs` dropped its migration story outright).

Also noted, no action taken: `makeStatusOp` still flattens an absent `ipns` to `''` in the payload while the new metadata fields are deliberately left absent. That inconsistency predates this task; the new fields could not copy it without destroying the `""`-vs-absent distinction the spec requires.
