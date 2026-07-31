---
'pinnace': patch
---

Document `pin` in the README: mirroring an external CID, and the `--from-ipns` migration that had no docs at all.

`pinnace pin` is half the product (it is what makes the boxes a pinning service for content you did not build, not only a deploy target), and `--from-ipns` is the one-command migration of an existing IPNS name onto your own nodes. Neither had a walkthrough. `--from-ipns` was not even in the command table's `pin` row: its only appearance in the whole README was incidental, inside an error-message example illustrating flag strictness, so an operator holding a CID or an old publisher's name could not find out from the docs that the verb they needed exists.

- A new "Mirror content you did not build: `pin`" section in the package README: mirroring a CID across every node, `--host` / `--no-recursive`, `--set-mode ipns` for your own stable name over someone else's content, and `site remove` to stop.
- A "Migrating from an existing IPNS name" sub-section: `--from-ipns` with the ENS-migration example, the accepted source forms (`k51...`, `/ipns/<id>`, `ipns://<id>`, DNSLink), the exactly-one-source rule, and the two deliberate non-features (you get YOUR name, not the source's key; a snapshot, not a follow).
- A "What can go wrong" sub-section: retrievability, the blocking `pin/add`, the `pin`/`place`/`publish` stage tags, some-nodes-pinned being a success, the up-front `ipns`-mode refusals, and `pin` versus `site add`.
- The command table's `pin` row now carries the `--from-ipns` source form, and the root README's pitch names the mirroring capability instead of reading as deploy-only.

Documentation only: no behaviour, flags or output changed.
