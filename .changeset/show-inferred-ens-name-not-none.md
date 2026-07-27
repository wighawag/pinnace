---
'pinnace': patch
---

Stop telling an operator a site has NO ENS name when it demonstrably has an inferred one.

Both status renderers described the STORED `ensName` field, but the column is READ as "what is this site's ENS name?". For a `.eth` site that stores none, those two answers differ, so the row contradicted itself: the CLI printed `ronan.eth: ... ensName unset eth.limo ronan.eth.limo`, and the dashboard showed a grey `none` in the `ens name` cell beside a ticked `ronan.eth.limo` link in the next one.

The `ens name` column now shows FOUR states instead of three, using the `ensNameToWarm` the report had ALREADY resolved: a STORED name prints as itself; an ABSENT name that resolved anyway prints as the name it warms, MARKED inferred (`ronan.eth (inferred)` on the CLI line, `ronan.eth` plus a muted `(inferred)` hint in the dashboard cell) so it stays distinguishable from a stored name that OVERRIDES the id; `""` still reads as `opted-out` / `opted out`; and a site with nothing stored and nothing resolved still reads as `unset` / `none`.

Display only. Nothing about resolution, warming or storage moves: the three-valued stored field, `resolveEnsNameToWarm` and what the box warms are unchanged, and the `status.json` payload keeps carrying raw, unannotated `ensName`/`ensNameToWarm` (the annotation is presentation, so machine readers see exactly what they saw before). The dashboard renderer still resolves nothing itself — it renders the name the report resolved, and a `.eth` id the report did not resolve still reads as `none`.
