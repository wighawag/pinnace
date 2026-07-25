---
'pinnace': minor
---

The on-box `warm` loop now resolves eth.limo warming from each site's MFS `metadata.ensName` instead of the bare "`id` ends in `.eth`" heuristic, so the `ensName` lever the client writes at deploy/pin time actually reaches the box (it reads the metadata that travels with the site in MFS). Per site, in strict precedence order:

- an explicit NON-EMPTY `ensName` warms `https://<ensName>.limo/` — for any site id, `.eth` or not, and it OVERRIDES a `.eth` id (the name, not the identity, decides);
- `ensName: ""` OPTS OUT: no eth.limo warm at all, even for a `.eth` id;
- an ABSENT `ensName` on a `.eth` id INFERS the name from the id, so a `.eth`-named site still auto-warms `https://<id>.limo/` with no configuration (unchanged behaviour for existing sites);
- an ABSENT `ensName` on a non-`.eth` id warms no ENS name.

The site's CID is still warmed through every configured gateway in all four cases (opting out of eth.limo is not opting out of warming), and warming failures stay recorded rather than thrown — a cold gateway never fails the run. The rule is exported as `resolveEnsNameToWarm(id, metadata)` from the package root, next to the write-side `resolveSiteMetadataToWrite`, so both sides of the three-valued `ensName` (a name / `""` / absent) are defined in one place.
