---
title: review-gate non-blocking nits for 'derive-version-from-package' (Gate 2 approve)
date: 2026-07-27
status: open
reviewOf: derive-version-from-package
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'derive-version-from-package' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: the derived pin can name a version that is not (yet) on npm. Provisioning from a checkout whose package.json was just bumped by the Version PR but not yet published, or from any local/unpublished build, emits PINNACE_VERSION=<unpublished>; the box then runs npm install -g pinnace@<unpublished>, which fails, and because pinnace-setup.sh is invoked with || true the box boots with NO agent and no loud signal. The old literal was by construction an already-published release, so this failure mode is new. The decisions note records the cost as 'a human no longer chooses the pin' but not this one. Ratify, or spin a follow-up (warn on provision when the version looks unpublished, or a boot smoke check).
  (src/provision/cloud-init.ts:290 default pin, :545 npm install -g, :638 pinnace-setup.sh || true; work/notes/observations/derive-version-from-package-decisions.md item 2)
- Claim drift in a doc comment: cloud-init.ts still opens with 'This module is PURE ... It does NOT touch the filesystem, the network, or SSH.', but it now imports src/version.ts, which readFileSync's package.json at module LOAD. provision() itself is still a pure function of its input, so the seam claim holds for callers, yet importing the provision module now hits the disk. Worth one clarifying clause so the next reader does not trust the absolute wording.
  (packages/pinnace/src/provision/cloud-init.ts:8-13 vs :59 import of ../version.js; src/version.ts top-level const calls readPackageVersion())
- Ratify the new refusal: a missing / unparseable / version-less package.json now throws at MODULE LOAD, via src/index.ts, so EVERY command fails at startup, not just the version verb. This is defensible (it means a broken install, and matches the repo convention that a check which could not run never reports a definitive answer) and is recorded as decision 4, but it is a new global failure path that the changeset's Decisions block does not list explicitly.
  (packages/pinnace/src/version.ts readPackageVersion() + export const PINNACE_VERSION; re-exported from src/index.ts)
- Bookkeeping: the task frontmatter says spec sites-metadata-in-mfs, covers [2], but story 2 of that spec is 'the config file is OPTIONAL, an endpoint + token on the CLI is enough' - unrelated to version resolution, and already delivered by config-drop-sites-and-make-optional. It follows an existing loose pattern in the repo (endpoint-flag-loud-and-global also claims [2]), so impact is low, but the spec's coverage map now double-counts story 2. Consider leaving covers empty for maintenance tasks.
  (work/tasks/done/derive-version-from-package.md frontmatter vs work/specs/sites-metadata-in-mfs.md user story 2)
