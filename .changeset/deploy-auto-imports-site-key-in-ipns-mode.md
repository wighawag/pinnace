---
'pinnace': patch
---

`deploy` now honours a resolved `ipns` mode the way `pin` already does: it either produces a working name or fails telling you exactly how to fix it, and never anything in between.

Previously a deploy asked for a name it could not sign exited 0 having landed the content: the publisher held no key for the site, the publish was silently skipped, and no `ipns://` line was printed. On a FIRST deploy that looked like a live name that did not exist; on a re-deploy of a site STORED as `ipns` (the mode is preserved, so this needs no flag) the content updated while the name kept pointing at the OLD cid, silently.

`deploy --set-mode ipns` (and a preserved stored `ipns`) now carries pin's policy. The key already on the publisher publishes as before, needing NO master: that is the CI path and it is unchanged. A publisher holding no key gets the DERIVED key imported (`importIpnsKeyIntoPublisher`, the same seam `pin`/`promote` use, which refuses a replica), so a new `ipns` site no longer needs a separate `pinnace promote` step; `promote` is now documented as the deliberate failover / replica-promotion path it is. Nothing is ever generated on the box: no `key/gen`, and no auto-promotion of a replica.

The two new refusals are PRE-FLIGHT, before the CAR is built and before any import, pin, MFS placement or metadata write on ANY node, so a deploy that cannot honour its mode changes nothing anywhere: `DeployDerivedKeyRequiredError` (a signing target holds no key and no key material was derivable, naming all three remedies: export `PINNACE_MASTER`, run `pinnace promote <id> --host <name>`, or deploy with `--set-mode ipfs`) and `DeployPublisherRequiredError` (nothing in the fan-out can sign: no publisher, or every publisher has `publish` disabled). Both are refusals of the WHOLE run, not per-node failures; a node that merely fails to answer its keystore probe is still just that node's failure, and the rest of the fan-out proceeds.

BEHAVIOUR CHANGE: `deploy --set-mode ipns` against a keyless publisher used to exit 0 without signing. It now either auto-imports the key (with `PINNACE_MASTER` set) or exits 1 having touched nothing. `--set-mode ipns` with every target unable to sign (previously a quiet land-only deploy) now also refuses. `ipfs` mode is completely unaffected: no keystore lookup, no master, no refusal. New from the package root: `DeployDerivedKeyRequiredError`, `DeployPublisherRequiredError`, and `DeployInput.derived` (the CLI derives it from the env-only master + the site `id`, exactly as `pin` does).
