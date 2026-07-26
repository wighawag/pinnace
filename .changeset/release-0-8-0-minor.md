---
'pinnace': minor
---

Release the post-reshape correction set as a MINOR, because two changes alter behaviour an existing setup can feel rather than merely repairing it.

- **`promote` is replaced by `authorize`** (breaking rename, `--host` dropped): the verb now targets the config's declared publisher, is idempotent, and no longer pretends to change any role. Failover is a reprovision, and the docs now say so.
- **`deploy --set-mode ipns` on a keyless publisher** no longer exits 0 having quietly signed nothing: it either imports the derived key (when the master is available) or refuses before writing to any node.
- **`republish` honours a site's stored `mode`**, so a site stored as `ipfs` is no longer signed just because a key for its id happens to sit in the keystore.

Together with the metadata write-path repairs and the `--endpoint` fixes, this is a behavioural release, not a patch.
