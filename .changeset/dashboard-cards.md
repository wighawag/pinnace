---
'pinnace': minor
---

Redesign the `node status` dashboard as centered per-site cards with full, readable identifiers.

The old page was one eleven-column table: the long nowrap cells pushed it past its centered column (so it read as off-centre), and the opaque `cid`/`ipns` identifiers had to be middle-elided to fit their cramped cells — hard to read and to compare across nodes. Each site is now a card on its own, so:

- the page is centered and never overflows its column;
- every opaque id (`cid`, `ipns`, the node `peerId`, and the `origin`/`freshness` paths) gets its own line at the card's full width and is shown in **full** (no elision), as an inverted-background badge that folds with `overflow-wrap: anywhere` instead of shredding into a one-character-per-line ribbon;
- a light/dark color scheme keeps the inverted id badge legible in both modes.

The full values still survive in the link `href`/`title` and in `status.json`, so showing them loses nothing. The honesty rules are unchanged: a check that could not run still renders the neutral `unknown (<reason>)`, never the red negative, and an absent verdict still reads `none`.