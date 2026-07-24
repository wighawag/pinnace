---
title: review-gate non-blocking nits for 'deploy-multi-target' (Gate 2 approve)
date: 2026-07-24
status: open
reviewOf: deploy-multi-target
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'deploy-multi-target' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Cross-task naming assumption: deploy resolves the publish key by exact match k.Name === name where name is the site ENS name (test uses mysite.eth), but the sibling key-import task imports the key under a caller-supplied keyName whose own test uses mysite (bare). If the CLI wires key-import with a keyId/short name while deploy passes the ENS name, key/list finds no match and deploy SILENTLY skips publishing. Human should ratify the single key-name convention the two tasks share before the CLI binds them.
  (deploy.ts publish(): keys.Keys.find(k=>k.Name===name); key-import.test.ts keyName:'mysite' vs deploy.test.ts name:'mysite.eth'. User story 9 also decouples keyId from ENS name.)
- User-visible default to ratify: when the publisher has no matching key in key/list, deploy lands+pins+MFS and returns published:false / ipns:undefined WITHOUT error, rather than reporting a failed publish. Reasonable (key provisioning is key-import's job) but it is a silent no-sign path an operator could miss; confirm this soft-skip is the intended contract vs a surfaced warning.
  (deploy.ts publish(): if(!ipns) return undefined; the node counts as ok with published:false.)
- In-scope design choice to ratify: DeployTarget gains a new publish?:boolean override (mirroring the prototype PUBLISH_IPNS=0) that is NOT sourced from config-resolution (which models publish capability only via role publisher/replica + publisherEndpoint). Additive and sanctioned by the task's publish-disabled-publisher clause, but confirm the per-target boolean is the intended lever vs deriving purely from role.
  (deploy.ts DeployTarget.publish; config-resolution has role + publisherEndpoint but no publish flag.)
