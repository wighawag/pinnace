---
title: build decisions for 'site-metadata-write-path-no-silent-loss' (add preserves; a failed read REFUSES)
date: 2026-07-26
status: open
reviewOf: site-metadata-write-path-no-silent-loss
---

# Closing the silent metadata-loss holes on the write path: build decisions (2026-07-26)

Decisions recorded while building the task `site-metadata-write-path-no-silent-loss` (`site add` gains the preserve semantics of `deploy`/`pin`; the WRITE path establishes absence positively and REFUSES on anything else). Captured here per the work contract because each one either sets a user-visible surface, introduces a new named concept, or touches another verb/flag/task.

Where this note is referenced from (so it is discoverable without trusting a claim): the `src/site/site-wrapper.ts` module JSDoc names it by path, and the completion report links it.

## 1. The absence probe WALKS UP to the MFS root, so a fresh box is not a refusal

Absence must be a POSITIVE fact (a successful `files/ls` that does not list the file), but the file's own directory may not exist yet: on a FIRST deploy there is no `/sites/<id>`, and on a fresh box there is no `/sites` either, so those listings fail exactly as a down node's do. `readSiteMetadataForWrite` therefore walks UP the path (`/sites/<id>` -> `/sites` -> ... -> `/`, which always exists in MFS) and lets the first level that ANSWERS decide: a listing without the next segment is a real absence; a listing that HAS the segment while the level below would not answer is an outage, and refuses. Cost: 1 RPC in the common re-write case (plus the read), 2 for a first write on a populated node, 3 on a fresh box. Alternatives considered: (a) treating a failed wrapper listing as absence, which re-opens the exact hole for the very common "site not yet on this node" shape; (b) `files/stat` instead of `files/ls`, same information but the task named the listing and `stat` is no less ambiguous about a failure; (c) refusing when the wrapper cannot be listed at all, which would make EVERY first deploy on a fresh box a refusal. Touches: `deploy`, both `pin` entry points, `site add` (all through `resolveSiteMetadataToWrite`), and any future write path that preserves.

## 2. NEW named concept: `SiteMetadataUnreadableError` (a REFUSAL, not a Kubo failure)

The write path needed a loud, typed refusal naming the site, the node and the failed step. It does NOT re-mean `KuboRpcError` (which reports one HTTP call's non-2xx and is carried as the `cause`): this error says pinnace DECLINED to write, which is a policy statement about stored state, not a transport fact. Coherence check against the existing vocabulary: it sits beside `EnsNameInferenceError` and `PinPublisherRequiredError` (refusals raised before anything is written) rather than beside `PinStageError` (a per-node stage report), and `pin` keeps wrapping it as its `place` stage, so the pin failure taxonomy is unchanged. Touches: the package's exported surface (`SiteMetadataUnreadableError`, `readSiteMetadataForWrite`), and any caller that pattern-matches deploy/pin failures.

## 3. `site add` now REFUSES too, which is a new user-visible failure on that verb

Giving `add` the preserve semantics necessarily gives it the refusal: preserving means reading, and reading may fail. So `pinnace site add <id> <cid>` against a down/401ing node now exits with the refusal instead of quietly writing `{mode:'ipfs'}`. That is the point of the task, but it IS a new refusal on a verb that previously never read anything, so it is recorded rather than buried. The operator's way past it is the same on every verb: state the whole record (`--set-mode` plus `--set-ens-name`/`--unset-ens-name`) and the write needs no read at all — except that `site add` has NO such flags today, so on `add` the only way past is to fix the node. Deliberately not widened here: giving `add` its own mode/ens flags is a surface decision beyond this task. Touches: the `site add` CLI verb, `CONTEXT.md`'s `pin` glossary entry (the deploy/add/pin trio), and any future task that gives `add` flags.

## 4. `site add`'s preserved `ipns` records ADDRESSING, and `add` still signs nothing

A re-`add` over a stored-`ipns` site now keeps `mode: 'ipns'` while `add` itself touches no key and never `name/publish`es. Consequence to ratify: adding a NEWER cid under a published name leaves the name pointing at the OLD cid until the next `deploy`/`pin`. Accepted because `mode` records how a site is ADDRESSED (CONTEXT.md `mode`), not what the last operation did; the alternative — demoting the site to `ipfs` because this particular operation did not sign — is precisely the silent loss the task closes. Touches: `site add`'s JSDoc DECISION block, the on-box republish loop (which republishes from the stored mode and will pick the site up on its next pass).

## 5. The tolerant read stays EXACTLY as it is, and is now pinned by a test from both sides

`readSiteMetadata` is unchanged: discovery still absorbs every failure into `{}` so one unreadable file cannot sink the on-box warm/republish/status pass. The two readings now live side by side with the split stated in both DECISION blocks, and a test asserts the SAME node and site read tolerantly (`{}`) and strictly (a refusal). Touches: `discoverSites` and the on-box loop (unchanged), the `readSiteMetadata` DECISION block (rescoped to DISCOVERY).

## 6. `MockKuboApi.onArg` (test surface) and a public `KuboRpcClient.baseUrl`

Two small enabling changes. `MockKuboApi.onArg(path, arg, spec)` lets a test model a real MFS TREE (where `files/ls /sites` and `files/ls /sites/<id>` must answer differently) instead of one canned answer per endpoint; it falls back to the existing `on(path, ...)`, so no existing test changes meaning. `KuboRpcClient.baseUrl` became a public readonly field so an error raised ABOUT a node can name it (a per-node client was otherwise anonymous, and "the metadata read failed" is useless during a fan-out). Touches: every test using the shared mock, and the client's public surface.
