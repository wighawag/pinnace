---
title: build decisions for 'deploy-auto-imports-site-key-in-ipns-mode' (deploy provisions its own key, or REFUSES)
date: 2026-07-26
status: open
reviewOf: deploy-auto-imports-site-key-in-ipns-mode
---

# `deploy --set-mode ipns` provisions-or-refuses: build decisions (2026-07-26)

Decisions recorded while building the task `deploy-auto-imports-site-key-in-ipns-mode`. Captured here per the work contract because each either touches another verb/flag, introduces a new refusal, or sets a user-visible surface, so a reviewer/human can ratify or reverse it.

Where this note is referenced from (so it is discoverable without trusting a claim): the `src/deploy/deploy.ts` module JSDoc names it by path, and the completion report links it. Nothing new entered the vocabulary: no new flag, config key, role or status. The two new errors mirror `pin`'s existing `PinPublisherRequiredError` / `PinDerivedKeyRequiredError`, and `DeployInput.derived` mirrors `PinExternalInput.derived`.

## 1. The keystore is PROBED up-front (`key/list` before anything is written), not asked mid-fan-out

Deploy cannot copy pin's policy verbatim. `pin` requires `derived` for ANY resolved `ipns` pin, but deploy's AC keeps the key-already-present path master-free (that is the CI path), so deploy must know whether each signing target already holds the key BEFORE it can decide between "import", "publish as-is" and "refuse". The lookup therefore moved from inside `publish()` to a pre-flight probe (`assertCanSign`), and its result is threaded into the fan-out so a signing target is still asked ONCE, not twice. `key/list` is a read: a refused deploy mutates nothing anywhere.

Visible consequence: the recorded call order for an ipns deploy is now `key/list` FIRST, then `dag/import` ... `name/publish` (the deploy test that pinned the old order was updated). Alternatives considered: (a) require `derived` always, like pin, rejected because it breaks the master-free CI deploy the task explicitly protects; (b) probe only when `derived` is absent, rejected because it gives two different call orders for the same verb and costs the CI path a duplicate `key/list`. Touches: `pin`'s policy (now shared), `lookupIpnsKeyId`'s callers, any test asserting deploy's ipns call sequence.

## 2. A publisher that cannot be PROBED does not refuse the run; it fails as its own node

If a target's `key/list` fails (a node that is down or 401ing), its keystore answer is unknown. That is deliberately NOT a refusal: the fan-out's documented partial-failure contract says one node must never sink the others. The deploy proceeds, that node fails in its own `allSettled` arm, and the SAME key-absent refusal (`DeployDerivedKeyRequiredError`) is repeated there as its per-node failure, so an unprobed node still cannot land content and quietly skip signing. Alternative considered: treat an unreachable probe as a whole-run refusal, rejected because a single down replica-of-a-publisher pair would then block a deploy the healthy publisher could serve. Touches: `DeployResult.failed` semantics, the partial-failure contract shared with `pin`.

## 3. ONE keyless signer refuses the WHOLE run (not just that node)

With several publishers and no derived key, if ANY of them holds no key the entire deploy is refused pre-flight rather than letting that node land content and skip its publish. Rationale: the failure this task exists to kill is exactly "content landed, name did not move"; a per-node version of it is the same bug on a smaller scale, and pre-flight is the only place a refusal costs nothing. Touches: multi-publisher fan-outs (rare today: one publisher per name is the model).

## 4. `publish: false` on EVERY target, in a resolved `ipns` mode, now REFUSES

Previously `deploy --set-mode ipns` against a single `publish: false` publisher landed the content and signed nothing, silently. It now raises `DeployPublisherRequiredError` (the task's AC 4: "no publisher, OR publish disabled"). The way to land content without signing is `--set-mode ipfs`, which says so. A `publish: false` target inside a fan-out that still has a real signer is unchanged: it lands + places and never signs (the existing test was rewritten into that shape). Touches: `DeployTarget.publish` (the prototype's `PUBLISH_IPNS=0`), any library caller using `publish: false` as a mode-independent "land only" switch.

## 5. The CLI does NOT refuse a missing master for `--set-mode ipns` (deliberately UNLIKE `runPin`)

`runPin` refuses up-front when `--set-mode ipns` is stated with no `PINNACE_MASTER`. `runDeploy` must not: the publisher may already hold the key, which is precisely how CI deploys (no master in CI). So `runDeploy` mirrors only pin's OPTIMISTIC half - derive whenever a master is available and the resolved mode could be `ipns` (stated `ipns` or preserved), a purely local KDF with no node contact - and leaves the decision to the core, which is the only layer that can see the keystore. The core's `DeployDerivedKeyRequiredError` / `DeployPublisherRequiredError` are caught in `runDeploy` and printed as a plain `pinnace deploy: <message>` exit 1.

Consequence to ratify: the two sibling verbs now differ at the CLI layer (`pin --set-mode ipns` with no master refuses immediately; `deploy --set-mode ipns` with no master may still succeed). That asymmetry is real and follows from pin having no key-already-present path to protect. Alternative considered: give `pin` deploy's probe too, so both are identical again; that is a change to `pin`'s behaviour and out of this task's scope, but it is the obvious follow-up if the asymmetry proves confusing. Touches: `runPin`, `runDeploy`, the CI path (`install-ci`), the README walkthrough.

## 6. No CLI-level publisher pre-check for deploy (pin has one)

`runPin` pre-checks the selected hosts so its message can name them (`b (replica)`), because `--host` lets an operator narrow to a replica. `deploy` has no `--host` (it always fans out to every configured host), so the only way to hit "nothing can sign" is a config with no publisher, which the core's error already describes by role. One check, in the core, rather than two messages to keep in sync. Touches: `runDeploy`, `DeployPublisherRequiredError`'s wording.
