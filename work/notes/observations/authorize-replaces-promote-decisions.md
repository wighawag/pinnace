---
title: build decisions for 'authorize-replaces-promote' (an honest verb that grants key MATERIAL)
date: 2026-07-26
status: open
reviewOf: authorize-replaces-promote
---

# `authorize` replaces `promote`: build decisions (2026-07-26)

Decisions recorded while building the task `authorize-replaces-promote`. Captured here per the work contract because each either introduces a new refusal, sets a user-visible surface, or shapes a seam another verb may copy, so a reviewer/human can ratify or reverse it.

Where this note is referenced from (so it is discoverable without trusting a claim): the `packages/pinnace/src/publisher/authorize.ts` module JSDoc names it by path, and the completion report links it.

Coherence check done first: `authorize` is a NEW verb name, so it was checked against the CONTEXT.md glossary, the ADRs and the code. The one near-collision is `token` / the RPC `Authorization: Bearer` header, a different layer; the new glossary entry states the distinction explicitly (`authorize` grants signing authority for a NAME, never RPC access to a node). Nothing else was re-meant: the two status tokens (`authorized` / `already-authorized`) follow the existing lowercase-hyphenated `SiteOutcome` style (`exported`, `no-key`, `ipfs-mode`), no new role/flag/config key entered the vocabulary, and the `KeyImportRoleError` refusal is reused rather than forked.

## 1. `--host` on `authorize` is a LOUD refusal, not an ignored flag

The task drops `--host` from this verb. The parser ignores unknown flags that carry a value, so doing nothing would have SILENTLY swallowed a targeting instruction from anyone with `pinnace promote <id> --host b` in their fingers or their scripts, and authorized a different node than they named. That is precisely the defect the `endpoint-flag-loud-and-global` change generalised ("a flag the operator typed must never mean nothing"), so `--host` is refused with a message that explains the new model (the config declares the publisher) and points at `--endpoint`. Alternative considered: accept `--host` when it happens to name the declared publisher, rejected because it re-introduces a second way to say one thing and a way to contradict it. Touches: anyone's existing `promote --host` invocations (which are breaking anyway), the README table, `pickHost` (still used by `site`, untouched).

## 2. The target's DECLARED role is passed to the key-import seam (the guard becomes real)

`promoteReplicaToPublisher` hard-coded `role: 'publisher'` when calling `importIpnsKeyIntoPublisher`, so the seam's replica refusal could never fire from that path — the caller invented the role it then checked. `AuthorizePublisherTarget.role` now carries what the CONFIG declares and is passed straight through, so a library caller handing over a declared replica is refused (`KeyImportRoleError`) with nothing written. This is not a resurrection of the deleted dead `currentRole` (which was never read): it is read, and it is the only thing that makes AC "a declared replica is still refused" true. Consequence to ratify: through the CLI the guard is unreachable by construction (the target is selected BY `role === 'publisher'`), and under `--endpoint` it is unreachable because the flag mints the role — both stated in the docs rather than dressed up as a check. Touches: `importIpnsKeyIntoPublisher`'s callers, ADR-0003's publisher-only rule.

## 3. `deriveKey` is a FUNCTION on the core input, not a pre-derived key

`deploy`/`pin` take a `derived` VALUE because they act on one known id. The bare `authorize` does not know its ids until it has walked MFS, so a value cannot be supplied up front. The core therefore takes `deriveKey: (id) => DerivedIpnsKey` and calls it only for sites it actually imports. This keeps the master env-only and out of the core (the CLI closes over it), and keeps discovery + the per-site loop in the CORE rather than leaking behaviour into the thin CLI. Alternatives considered: (a) discover in the CLI and call a single-site core per id — puts a loop and a discovery decision in the wrapper, against the core-vs-cli rule; (b) have the CLI pass the master — breaks the env-only boundary every other core module holds. Touches: the `ClientDeps` seam shape, any future verb that needs key material for a set of sites.

## 4. A host that cannot be ASKED is reported `unchecked`, never a refusal and never "holds nothing"

The second-signer guard asks every other configured host `key/list`. Two ways that can fail: the box does not answer (down / 401), or its bearer token is not exported at all. Neither is treated as a conflict, and neither fails the run: the host names are collected and printed as a `note:` line naming what was not covered. Rationale: the guard is best-effort BY CONSTRUCTION (the task itself has it skipped wholesale under `--endpoint`), and the primary use is a local CI bootstrap where an unrelated replica being down — or its token simply not being in this shell — must not block the one command that makes CI work. Alternatives considered: (a) refuse when any host cannot be asked, rejected as the strictest verb in the CLI for no gain, since it blocks on hosts that are not signing anything right now; (b) resolve every host's token eagerly and fail loud like `deploy`/`status` do, rejected for the same reason plus the standing LAZY-token rule (only hosts an operation USES must have a token) — this verb only WRITES to the publisher. Consequence to ratify: `authorize` can succeed while the two-signer hazard on an unreachable box goes unseen, which is why the note is printed rather than swallowed. Touches: `resolveHostToken`'s lazy contract, the message an operator sees on a partly-down fleet.

## 5. The conflict check is PRE-FLIGHT across the WHOLE run

In the bare form the guard is evaluated for every site that needs an import BEFORE the first `key/import`, so one conflicting site refuses the whole run with nothing imported, rather than importing sites 1-2 and dying on site 3. This mirrors `deploy`'s pre-flight refusals (a run that cannot be honoured changes nothing anywhere). Touches: the bare form's failure semantics; note that an RPC failure mid-import is still a partial run, as everywhere else.

## 6. The bare form does NOT filter on the site's stored `mode`

Every site discovered under `/sites/*` is authorized, including one stored as `mode: ipfs`. Authorize grants MATERIAL; whether a name is ever signed stays `mode`'s business on the box (a stored-`ipfs` site is never signed even where a key exists — CONTEXT.md `mode`, the `ipfs-mode` republish outcome), so the key is inert there. Alternative considered: skip `ipfs` sites, rejected because it makes `authorize` silently partial the moment an operator flips a mode, which is exactly the "the name did not move and nothing said so" failure class this repo keeps killing. Touches: `mode`'s meaning (unchanged), what a bare run reports.

## 7. A bare run with no MFS sites is exit 0 with an explanatory line

Nothing to do is not an error (it matches `site list` on a fresh box). The line names the alternative (`pinnace authorize <id>`), because the pre-deploy CI-bootstrap case is exactly when MFS is empty and the operator still wants a key placed. Touches: exit-code expectations for scripts wrapping the verb.
