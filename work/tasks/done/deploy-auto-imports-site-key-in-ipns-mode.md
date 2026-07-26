---
title: deploy in ipns mode provisions its own key (like pin) and REFUSES rather than silently not signing
slug: deploy-auto-imports-site-key-in-ipns-mode
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: []
covers: [4]
---

## What to build

`deploy` is the ONLY verb that can be asked for a stable name and quietly not deliver one. In `ipns` mode, if the publisher's keystore holds no key for the site `id`, `publish()` returns `undefined` and the deploy "lands the content but does not sign": exit 0, the CID printed, no `ipns://` line, and no error. On a FIRST deploy the operator thinks a name is live when it is not; on a RE-deploy of a site STORED as `ipns` (the mode is now preserved, so this needs no flag at all) the content updates while the name keeps pointing at the OLD cid, silently. That is precisely the failure `pin` refuses to allow.

`pin --set-mode ipns` already solves this with the OPPOSITE policy, and deploy's own source comments say so: pin IMPORTS the derived key first "because the operator just asked for that name", and refuses loudly (`PinDerivedKeyRequiredError`, `PinPublisherRequiredError`) up-front when it cannot. Make `deploy` behave like `pin`. The two verbs should differ in what they PLACE, never in whether they honour a stated mode.

### The resolution, for a target that would publish (`shouldPublish`: role `publisher`, `publish !== false`)

1. **Key already present in the publisher's keystore** -> publish exactly as today. This path MUST NOT require the master: it is the CI path (promote/auto-import happens once from the operator's machine, then every later deploy just signs). Do not regress it.
2. **Key absent + the derived key is available** -> IMPORT it, then publish. Reuse `importIpnsKeyIntoPublisher` (the same seam `promote` uses); do NOT re-implement the import, and do NOT `key/gen` (the key is DERIVED, never invented). The CLI derives from the env-only master + the site `id`, exactly as `runPin` already does, and passes it into the core, because only the core knows the RESOLVED mode.
3. **Key absent + no derived key available (no `PINNACE_MASTER`)** -> REFUSE, loudly, naming all three remedies: export `PINNACE_MASTER`, or run `pinnace promote <id> --host <name>`, or deploy with `--set-mode ipfs`. Mirror `PinDerivedKeyRequiredError`'s shape, including its distinction between a STATED `--set-mode ipns` and one PRESERVED from the site's stored metadata (the preserved wording must explain that the site is already published under this name and the deploy must refresh it).
4. **No target among the fan-out can sign at all** (no publisher, or publish disabled) while the resolved mode is `ipns` -> REFUSE, mirroring `PinPublisherRequiredError`.
5. **A `replica` target** -> unchanged: never imports, never signs, lands+pins+MFS only. Auto-import must NEVER promote a replica; `importIpnsKeyIntoPublisher` already refuses a non-publisher role and that guard stays. Turning a replica into a publisher stays the deliberate, operator-driven `promote` (its real job is failover, which is inherently post-boot).

### Refuse BEFORE mutating anything

Every refusal above must happen UP-FRONT, before any CAR import, pin, MFS write or metadata write, so a deploy that cannot honour its mode changes nothing on any node. `pin` already does this (`assertEnsNameIntent` and both refusals precede node contact), and the ens-intent assertion in deploy is already hoisted for the same reason: "so this cannot fire mid-fan-out". Follow that discipline. A half-deployed fan-out whose name never moved is the worst outcome available.

Note the interaction with the fan-out's partial-failure semantics (a non-empty subset of nodes succeeding is still a success): these are PRE-FLIGHT refusals of the whole run, not per-node failures, so they must not be folded into `Promise.allSettled`.

## Acceptance criteria

- [ ] `deploy` in `ipns` mode with NO key on the publisher and a derived key available IMPORTS the key (via `importIpnsKeyIntoPublisher`, no `key/gen`) and then publishes; the resulting `ipns://` id is reported (tested at the mock seam).
- [ ] `deploy` in `ipns` mode with the key ALREADY present publishes WITHOUT requiring the master and WITHOUT re-importing (tested: no `key/import` is issued, and the deploy succeeds with no master in the env) — the CI path must not regress.
- [ ] `deploy` in `ipns` mode with no key and NO master REFUSES with a loud error naming all three remedies, and distinguishes a STATED `--set-mode ipns` from a PRESERVED stored `ipns` in its wording (tested both).
- [ ] A resolved `ipns` mode with no signing-capable target REFUSES, mirroring `PinPublisherRequiredError` (tested).
- [ ] Every refusal is PRE-FLIGHT: no CAR import, pin, MFS placement or metadata write happens on ANY node when a deploy is refused (tested by asserting the mock recorded no mutating call).
- [ ] A `replica` target still never receives a key and never signs; auto-import cannot promote a replica (tested).
- [ ] `ipfs` mode is completely unaffected (no key lookup, no master, no refusal).
- [ ] The stale source comments claiming deploy "skips the publish rather than silently generating a key" and describing pin as having "the OPPOSITE policy" are corrected: the two verbs now share one policy.
- [ ] The package README's end-to-end walkthrough is updated: `deploy --set-mode ipns` now provisions its own key, so the separate `promote` step is no longer required for a NEW site, and `promote` is documented as the deliberate failover/replica-promotion path it is. Any ordering advice that assumed deploy-then-promote is corrected.
- [ ] Test-first, at the mock Kubo seam; env/config isolated; no live daemon. A changeset is included, calling out that `deploy --set-mode ipns` on a keyless publisher changes from silent no-op to either auto-import or a loud refusal.

## Blocked by

- None. Touches `src/deploy/deploy.ts` + `src/cli/run.ts` (deploy's arm only), so it is orthogonal to the pin/site paths.

## Prompt

> Goal: make `deploy` honour a stated `ipns` mode the way `pin` already does, instead of quietly not signing. Read `src/deploy/deploy.ts` (`publish`, `shouldPublish`, `resolveFanOutMode`, and the comment claiming pin has "the OPPOSITE policy"), `src/pin/pin-external.ts` (`PinDerivedKeyRequiredError`, `PinPublisherRequiredError`, and where they are thrown relative to node contact), `src/publisher/key-import.ts` (`importIpnsKeyIntoPublisher`, which REFUSES a replica), `src/cli/run.ts` (`runPin`'s optimistic derive-when-master-is-set, which `runDeploy` should mirror), and ADR-0003 (the client supplies key MATERIAL; the node signs).
>
> Today a deploy asked for a name it cannot sign exits 0 having landed content, so a re-deploy of a stored-`ipns` site silently leaves the name on the OLD cid. Give deploy pin's policy: import the DERIVED key when it is missing and available, refuse loudly when it is missing and unavailable, and refuse when nothing in the fan-out can sign. Keep the key-already-present path master-free, because that is how CI deploys.
>
> Refuse BEFORE anything is written to any node. Never `key/gen`, never auto-promote a replica.
>
> Done means: `deploy --set-mode ipns` either produces a working name or fails telling you exactly how to fix it, and never anything in between.
