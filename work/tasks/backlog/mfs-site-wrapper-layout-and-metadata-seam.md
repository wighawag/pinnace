---
title: Wrapper MFS layout /sites/<id>/{content,metadata.json} + metadata seam (placeInMfs + discoverSites)
slug: mfs-site-wrapper-layout-and-metadata-seam
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: [kubo-client-files-read-write]
covers: [3, 5, 7]
---

## What to build

Change the MFS site layout from a flat `/sites/<id>` (= the content root CID directly) to a WRAPPER directory `/sites/<id>/` containing `content` (the UnixFS root CID) and `metadata.json` (per-site metadata). This is the load-bearing seam change for the whole spec: it is CONCENTRATED in two shared functions that every content-CID reader/writer flows through, so change them atomically and the callers get the new shape through the same interface.

- **`placeInMfs(client, sitesDir, id, cid, metadata)`** — write the WRAPPER: `files/mkdir /sites/<id> --parents`, `files/rm /sites/<id>/content --force`, `files/cp /ipfs/<cid> /sites/<id>/content`, and `files/write /sites/<id>/metadata.json` (the JSON metadata, via the new `filesWrite`). It gains a `metadata` parameter. Idempotent (re-placing replaces content + metadata).
- **`discoverSites(client, sitesDir)`** — for each entry under `/sites/*` (still a listing of entries, but each entry is now a DIR), read the CONTENT cid from `/sites/<id>/content` (`files/stat --hash` on the content subpath, NOT the wrapper dir) AND read + parse `/sites/<id>/metadata.json` (via `filesRead`; absent/malformed metadata is tolerated — treat as empty `{}`, do not fail discovery). `DiscoveredSite` gains a `metadata` field (`{ ensName?, mode? }`).
- **`metadata.json` shape:** `{ ensName?: string, mode: "ipfs" | "ipns" }`, small JSON. `ensName: ""` (empty string) MUST be preserved as distinct from absent (opt-out vs infer) through write + read + parse — do not coerce `""` to undefined.
- **`removeSite` unpin path:** `statCid` must read the content cid from `/sites/<id>/content` (not `/sites/<id>`) before `files/rm /sites/<id>` (recursive removes the whole wrapper). The unpin then targets the content cid.

Every caller (deploy, pin, status, warm, publish) consumes `DiscoveredSite.cid` / calls `placeInMfs` — so once these two seams speak the wrapper layout, callers get the content cid unchanged in shape; their only required change is PASSING metadata into `placeInMfs` (owned by the deploy/pin write tasks) and READING `metadata` off `DiscoveredSite` (owned by the on-box/warm tasks). This task delivers the seam + `removeSite`; it keeps the gate green because it updates every in-package caller's CALL to the two changed functions (adding the metadata arg with a sensible default so nothing breaks), leaving the BEHAVIOURAL use of metadata (writing real ensName/mode, resolving warming) to the sibling tasks.

## Acceptance criteria

- [ ] `placeInMfs` writes the wrapper `/sites/<id>/{content, metadata.json}` (mkdir parents, rm+cp content, filesWrite metadata); re-placing replaces both. A test asserts the exact MFS calls against the mock.
- [ ] `discoverSites` reads the content cid from `/sites/<id>/content` and reads+parses `/sites/<id>/metadata.json`; `DiscoveredSite` carries `{id, cid, metadata}`; absent/malformed metadata yields empty metadata, not a discovery failure (tested).
- [ ] `metadata.json` round-trips `{ ensName?, mode }` with `ensName: ""` preserved DISTINCT from absent (tested both directions).
- [ ] `removeSite` reads the content cid from `/sites/<id>/content`, then `files/rm /sites/<id>` (recursive) and unpins the content cid (tested against the mock).
- [ ] Every in-package caller of `placeInMfs` / `discoverSites` compiles against the new signatures (metadata arg defaulted where the real value is a sibling task's job), so `pnpm build` + the suite stay green.
- [ ] Test-first: the failing seam tests are written before the change. Tests hit the mock Kubo API only (no live daemon / shared location).

## Blocked by

- Blocked by `kubo-client-files-read-write` (needs `filesWrite`/`filesRead`).

## Prompt

> Goal: move the MFS site layout to a WRAPPER dir `/sites/<id>/{content, metadata.json}` and thread per-site metadata through the two shared seam functions. Read the spec `sites-metadata-in-mfs` (Impl Decisions: the wrapper layout + the content-CID-reader consequence), the done tasks `site-management` (`placeInMfs`, `removeSite`, `statCid`), `node-agent-commands` (`discoverSites`, `DiscoveredSite`), and `kubo-client-files-read-write` (the new `filesWrite`/`filesRead`).
>
> This is a contained wide-refactor: the flat `/sites/<id>` = content-cid becomes `/sites/<id>/content` + `/sites/<id>/metadata.json`, and it concentrates in `placeInMfs` (write the wrapper, take a `metadata` arg) + `discoverSites` (read content from `/sites/<id>/content`, read+parse metadata.json, add `metadata` to `DiscoveredSite`) + `removeSite`/`statCid` (unpin the content subpath). `metadata` = `{ ensName?: string, mode: "ipfs"|"ipns" }`; PRESERVE `ensName: ""` distinct from absent through write/read. Keep the gate green: update every in-package caller's CALL to the two functions (default the metadata arg so nothing breaks) — the BEHAVIOURAL metadata use (real ensName/mode on deploy/pin; warming resolution) is sibling tasks. Test-first at the mock Kubo seam (the exact MFS calls, metadata round-trip incl. empty-string, discovery tolerating absent metadata, removeSite unpinning the content cid). Done means the wrapper layout + metadata seam is in place and green, ready for deploy/pin to write real metadata and the on-box loop to read it.
