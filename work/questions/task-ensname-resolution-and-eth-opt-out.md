<!-- dorfl-sidecar: item=task:ensname-resolution-and-eth-opt-out type=task slug=ensname-resolution-and-eth-opt-out allAnswered=false -->

## Q1

**'task:ensname-resolution-and-eth-opt-out' was bounced — how should we proceed?**

> The task hides an unresolved, user-visible design decision: there is NO channel by which a site's `ensName` (a `pinnace.json` field) can reach the `warm` verb, so 3 of the 4 acceptance cases are unimplementable end-to-end.
>
> FALSE PREMISE (where):
> 1. `ensName` lives ONLY in `pinnace.json` -> `SiteConfig.ensName` (`packages/pinnace/src/config/config-resolution.ts:84`), and `pinnace.json` is read ONLY by the CLIENT CLI (`packages/pinnace/src/cli/run.ts`, `defaultLoadConfigFile` + `resolveContext`).
> 2. `warm` is an ON-BOX verb. `runNodeCli` (`packages/pinnace/src/cli/run.ts`, ~1000-1045) assembles `NodeCommandContext` exclusively from box env keys (`RPC_BEARER_TOKEN`, `NODE_ROLE`, `SITES_DIR`, `WARM_GATEWAYS`, `RECORDS_DIR`, `CACHE_DIR`, `DASHBOARD_DIR`, `PUBLISHER_ENDPOINT`) and NEVER from the config file; `defaultWarm` (`packages/pinnace/src/node/node-commands.ts`) iterates `DiscoveredSite {id, cid}` from `discoverSites` (MFS `/sites/*`). Neither type nor context has any `ensName`/site-config input.
> 3. The box has no config file to read: cloud-init writes only `/etc/pinnace-node.env` (`packages/pinnace/src/provision/cloud-init.ts:350-366`), which contains zero per-site data, and each timer unit runs `pinnace node <verb>` with `EnvironmentFile=/etc/pinnace-node.env` (`cloud-init.ts:235-260`). `ProvisionInput` has no site list either.
>
> CONSEQUENCE: case 2 (`.eth` id inference) is the ONLY case reachable on a real box, and it is what the code already does. Case 1 (explicit non-empty `ensName`) and case 3 (`ensName: ""` opt-out) cannot fire in production, so acceptance criteria 1/3/4 and the task's "Done means `ensName` is the real, documented lever ... `ensName: ""` cleanly opts out" cannot be satisfied by a warm-seam change alone. Implementing only the seam (an injectable per-site hint map on `NodeCommandContext`) plus the CONTEXT.md / field-doc rewrite would DOCUMENT a lever that nothing can pull, i.e. reproduce the exact "documented-as-hint but ignored" defect the task exists to remove.
>
> THE UNDECIDED DESIGN (what a human must choose): how do per-site ENS warming hints reach the on-box warm loop? The candidates have materially different, hard-to-reverse consequences and each touches ANOTHER command:
> (a) Snapshot them into `/etc/pinnace-node.env` at provision time (e.g. `WARM_ENS_NAMES="id=ens id2="`): needs new site data on `ProvisionInput` + a new user-visible env key, contradicts run.ts's documented "provision is purely arg-driven (provisioning inputs are per-box and not stored in `pinnace.json`)", and is stale by construction (changing a site's `ensName`, or adding a site, needs a re-provision or a hand-edited env file on a long-lived box).
> (b) Push hints to the box at `deploy` / `site add` time into on-box state (e.g. `/etc/pinnace-sites.json`): no such channel exists, and deploy speaks ONLY Kubo RPC (it cannot write box files).
> (c) Store the hint in MFS next to the site (e.g. `/sites-meta/<id>/ens`): invents a new MFS metadata concept not in CONTEXT.md, and changes what `discoverSites` means for every verb.
> (d) Leave the box's resolution id-based and make `ensName` a CLIENT-side lever behind a NEW client-side `warm` verb: a new command, and the recurring on-box loop (the thing that actually keeps caches hot per ADR-0002) would still ignore `ensName`.
>
> SPEC TENSION (also unreconciled): spec story 15 (`work/specs/tasked/pinnace.md:41`) itself sanctions the current behaviour: "warm a configurable set of public gateways (dweb.link, eth.limo for `.eth` names, ...) for every site discovered in MFS" — MFS-discovery-only input, eth.limo keyed off `.eth` NAMES. Story 9 has the same ENS framing. The idea note this task claims to discharge (`work/notes/ideas/drop-ens-from-pinnace-model.md`, "The change shape" + "Why this is an IDEA, not a silent edit") explicitly says this is a SPEC-level reshape requiring reopen `specs/tasked/ -> specs/ready/`, reconcile, then re-task — and the spec is still in `specs/tasked/` with stories 9/15 unreconciled. So the task was emitted ahead of the spec step its own source note requires.
>
> SECOND UNDER-SPECIFICATION: the task twice mentions eth.link ("and eth.link if that is included", "no eth warming ... eth.limo/eth.link"), but eth.link appears NOWHERE in the codebase: `DEFAULT_GATEWAYS` (`cloud-init.ts`) is dweb.link / cf-ipfs.com / ipfs.io, and `defaultWarm` hardcodes only `https://<id>.limo/`. So "and eth.link" is either a new gateway to add (a user-visible default change, not stated as a criterion) or dead wording that should be struck.
>
> SUGGESTED RE-SCOPE (split into three):
> 1. Reopen the `pinnace` spec (`specs/tasked/ -> specs/ready/`) and reconcile stories 9 + 15 to the ENS-demotion model (identity decoupled from ENS; warming driven by an explicit hint), per the idea note's own instruction.
> 2. Record a decision/ADR answering "how do per-site ENS hints reach the on-box warm loop", choosing among (a)-(d) above with the staleness tradeoff stated. This is the load-bearing bit: it fixes a new on-box env key / on-box state file / MFS convention that provisioned boxes will carry.
> 3. THEN a small task implementing the four-case resolution (`explicit non-empty > "" opt-out > .eth inference > nothing`) at the warm seam over whatever channel (2) chose, test-first, with the `""`-vs-undefined distinction (note `resolveConfig` already preserves it: `sites: file.sites ?? []` copies site entries verbatim, so only a test is needed there), plus an explicit yes/no on eth.link.
>
> If the owner instead wants something shippable NOW, the task must be rewritten to NAME the channel (my read: option (a), `WARM_ENS_NAMES` in `/etc/pinnace-node.env` + a `provision` input, accepting the re-provision-to-change staleness) and to say that `pinnace provision` starts carrying site-derived data — a change I will not make silently under a task whose criteria never mention `provision` or cloud-init.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):

## Q2

**'task:ensname-resolution-and-eth-opt-out' was bounced — how should we proceed?**

> The task hides an unresolved, user-visible design decision: there is NO channel by which a site's `ensName` (a `pinnace.json` field) can reach the `warm` verb, so 3 of the 4 acceptance cases are unimplementable end-to-end.
>
> FALSE PREMISE (where):
> 1. `ensName` lives ONLY in `pinnace.json` -> `SiteConfig.ensName` (`packages/pinnace/src/config/config-resolution.ts:84`), and `pinnace.json` is read ONLY by the CLIENT CLI (`packages/pinnace/src/cli/run.ts`, `defaultLoadConfigFile` + `resolveContext`).
> 2. `warm` is an ON-BOX verb. `runNodeCli` (`packages/pinnace/src/cli/run.ts`, ~1000-1045) assembles `NodeCommandContext` exclusively from box env keys (`RPC_BEARER_TOKEN`, `NODE_ROLE`, `SITES_DIR`, `WARM_GATEWAYS`, `RECORDS_DIR`, `CACHE_DIR`, `DASHBOARD_DIR`, `PUBLISHER_ENDPOINT`) and NEVER from the config file; `defaultWarm` (`packages/pinnace/src/node/node-commands.ts`) iterates `DiscoveredSite {id, cid}` from `discoverSites` (MFS `/sites/*`). Neither type nor context has any `ensName`/site-config input.
> 3. The box has no config file to read: cloud-init writes only `/etc/pinnace-node.env` (`packages/pinnace/src/provision/cloud-init.ts:350-366`), which contains zero per-site data, and each timer unit runs `pinnace node <verb>` with `EnvironmentFile=/etc/pinnace-node.env` (`cloud-init.ts:235-260`). `ProvisionInput` has no site list either.
>
> CONSEQUENCE: case 2 (`.eth` id inference) is the ONLY case reachable on a real box, and it is what the code already does. Case 1 (explicit non-empty `ensName`) and case 3 (`ensName: ""` opt-out) cannot fire in production, so acceptance criteria 1/3/4 and the task's "Done means `ensName` is the real, documented lever ... `ensName: ""` cleanly opts out" cannot be satisfied by a warm-seam change alone. Implementing only the seam (an injectable per-site hint map on `NodeCommandContext`) plus the CONTEXT.md / field-doc rewrite would DOCUMENT a lever that nothing can pull, i.e. reproduce the exact "documented-as-hint but ignored" defect the task exists to remove.
>
> THE UNDECIDED DESIGN (what a human must choose): how do per-site ENS warming hints reach the on-box warm loop? The candidates have materially different, hard-to-reverse consequences and each touches ANOTHER command:
> (a) Snapshot them into `/etc/pinnace-node.env` at provision time (e.g. `WARM_ENS_NAMES="id=ens id2="`): needs new site data on `ProvisionInput` + a new user-visible env key, contradicts run.ts's documented "provision is purely arg-driven (provisioning inputs are per-box and not stored in `pinnace.json`)", and is stale by construction (changing a site's `ensName`, or adding a site, needs a re-provision or a hand-edited env file on a long-lived box).
> (b) Push hints to the box at `deploy` / `site add` time into on-box state (e.g. `/etc/pinnace-sites.json`): no such channel exists, and deploy speaks ONLY Kubo RPC (it cannot write box files).
> (c) Store the hint in MFS next to the site (e.g. `/sites-meta/<id>/ens`): invents a new MFS metadata concept not in CONTEXT.md, and changes what `discoverSites` means for every verb.
> (d) Leave the box's resolution id-based and make `ensName` a CLIENT-side lever behind a NEW client-side `warm` verb: a new command, and the recurring on-box loop (the thing that actually keeps caches hot per ADR-0002) would still ignore `ensName`.
>
> SPEC TENSION (also unreconciled): spec story 15 (`work/specs/tasked/pinnace.md:41`) itself sanctions the current behaviour: "warm a configurable set of public gateways (dweb.link, eth.limo for `.eth` names, ...) for every site discovered in MFS" — MFS-discovery-only input, eth.limo keyed off `.eth` NAMES. Story 9 has the same ENS framing. The idea note this task claims to discharge (`work/notes/ideas/drop-ens-from-pinnace-model.md`, "The change shape" + "Why this is an IDEA, not a silent edit") explicitly says this is a SPEC-level reshape requiring reopen `specs/tasked/ -> specs/ready/`, reconcile, then re-task — and the spec is still in `specs/tasked/` with stories 9/15 unreconciled. So the task was emitted ahead of the spec step its own source note requires.
>
> SECOND UNDER-SPECIFICATION: the task twice mentions eth.link ("and eth.link if that is included", "no eth warming ... eth.limo/eth.link"), but eth.link appears NOWHERE in the codebase: `DEFAULT_GATEWAYS` (`cloud-init.ts`) is dweb.link / cf-ipfs.com / ipfs.io, and `defaultWarm` hardcodes only `https://<id>.limo/`. So "and eth.link" is either a new gateway to add (a user-visible default change, not stated as a criterion) or dead wording that should be struck.
>
> SUGGESTED RE-SCOPE (split into three):
> 1. Reopen the `pinnace` spec (`specs/tasked/ -> specs/ready/`) and reconcile stories 9 + 15 to the ENS-demotion model (identity decoupled from ENS; warming driven by an explicit hint), per the idea note's own instruction.
> 2. Record a decision/ADR answering "how do per-site ENS hints reach the on-box warm loop", choosing among (a)-(d) above with the staleness tradeoff stated. This is the load-bearing bit: it fixes a new on-box env key / on-box state file / MFS convention that provisioned boxes will carry.
> 3. THEN a small task implementing the four-case resolution (`explicit non-empty > "" opt-out > .eth inference > nothing`) at the warm seam over whatever channel (2) chose, test-first, with the `""`-vs-undefined distinction (note `resolveConfig` already preserves it: `sites: file.sites ?? []` copies site entries verbatim, so only a test is needed there), plus an explicit yes/no on eth.link.
>
> If the owner instead wants something shippable NOW, the task must be rewritten to NAME the channel (my read: option (a), `WARM_ENS_NAMES` in `/etc/pinnace-node.env` + a `provision` input, accepting the re-provision-to-change staleness) and to say that `pinnace provision` starts carrying site-derived data — a change I will not make silently under a task whose criteria never mention `provision` or cloud-init.

<!-- q2 fields: id=q2 kind=stuck -->

**Your answer** (write below this line):

## Q3

**'task:ensname-resolution-and-eth-opt-out' was bounced — how should we proceed?**

> The task hides an unresolved, user-visible design decision: there is NO channel by which a site's `ensName` (a `pinnace.json` field) can reach the `warm` verb, so 3 of the 4 acceptance cases are unimplementable end-to-end.
>
> FALSE PREMISE (where):
> 1. `ensName` lives ONLY in `pinnace.json` -> `SiteConfig.ensName` (`packages/pinnace/src/config/config-resolution.ts:84`), and `pinnace.json` is read ONLY by the CLIENT CLI (`packages/pinnace/src/cli/run.ts`, `defaultLoadConfigFile` + `resolveContext`).
> 2. `warm` is an ON-BOX verb. `runNodeCli` (`packages/pinnace/src/cli/run.ts`, ~1000-1045) assembles `NodeCommandContext` exclusively from box env keys (`RPC_BEARER_TOKEN`, `NODE_ROLE`, `SITES_DIR`, `WARM_GATEWAYS`, `RECORDS_DIR`, `CACHE_DIR`, `DASHBOARD_DIR`, `PUBLISHER_ENDPOINT`) and NEVER from the config file; `defaultWarm` (`packages/pinnace/src/node/node-commands.ts`) iterates `DiscoveredSite {id, cid}` from `discoverSites` (MFS `/sites/*`). Neither type nor context has any `ensName`/site-config input.
> 3. The box has no config file to read: cloud-init writes only `/etc/pinnace-node.env` (`packages/pinnace/src/provision/cloud-init.ts:350-366`), which contains zero per-site data, and each timer unit runs `pinnace node <verb>` with `EnvironmentFile=/etc/pinnace-node.env` (`cloud-init.ts:235-260`). `ProvisionInput` has no site list either.
>
> CONSEQUENCE: case 2 (`.eth` id inference) is the ONLY case reachable on a real box, and it is what the code already does. Case 1 (explicit non-empty `ensName`) and case 3 (`ensName: ""` opt-out) cannot fire in production, so acceptance criteria 1/3/4 and the task's "Done means `ensName` is the real, documented lever ... `ensName: ""` cleanly opts out" cannot be satisfied by a warm-seam change alone. Implementing only the seam (an injectable per-site hint map on `NodeCommandContext`) plus the CONTEXT.md / field-doc rewrite would DOCUMENT a lever that nothing can pull, i.e. reproduce the exact "documented-as-hint but ignored" defect the task exists to remove.
>
> THE UNDECIDED DESIGN (what a human must choose): how do per-site ENS warming hints reach the on-box warm loop? The candidates have materially different, hard-to-reverse consequences and each touches ANOTHER command:
> (a) Snapshot them into `/etc/pinnace-node.env` at provision time (e.g. `WARM_ENS_NAMES="id=ens id2="`): needs new site data on `ProvisionInput` + a new user-visible env key, contradicts run.ts's documented "provision is purely arg-driven (provisioning inputs are per-box and not stored in `pinnace.json`)", and is stale by construction (changing a site's `ensName`, or adding a site, needs a re-provision or a hand-edited env file on a long-lived box).
> (b) Push hints to the box at `deploy` / `site add` time into on-box state (e.g. `/etc/pinnace-sites.json`): no such channel exists, and deploy speaks ONLY Kubo RPC (it cannot write box files).
> (c) Store the hint in MFS next to the site (e.g. `/sites-meta/<id>/ens`): invents a new MFS metadata concept not in CONTEXT.md, and changes what `discoverSites` means for every verb.
> (d) Leave the box's resolution id-based and make `ensName` a CLIENT-side lever behind a NEW client-side `warm` verb: a new command, and the recurring on-box loop (the thing that actually keeps caches hot per ADR-0002) would still ignore `ensName`.
>
> SPEC TENSION (also unreconciled): spec story 15 (`work/specs/tasked/pinnace.md:41`) itself sanctions the current behaviour: "warm a configurable set of public gateways (dweb.link, eth.limo for `.eth` names, ...) for every site discovered in MFS" — MFS-discovery-only input, eth.limo keyed off `.eth` NAMES. Story 9 has the same ENS framing. The idea note this task claims to discharge (`work/notes/ideas/drop-ens-from-pinnace-model.md`, "The change shape" + "Why this is an IDEA, not a silent edit") explicitly says this is a SPEC-level reshape requiring reopen `specs/tasked/ -> specs/ready/`, reconcile, then re-task — and the spec is still in `specs/tasked/` with stories 9/15 unreconciled. So the task was emitted ahead of the spec step its own source note requires.
>
> SECOND UNDER-SPECIFICATION: the task twice mentions eth.link ("and eth.link if that is included", "no eth warming ... eth.limo/eth.link"), but eth.link appears NOWHERE in the codebase: `DEFAULT_GATEWAYS` (`cloud-init.ts`) is dweb.link / cf-ipfs.com / ipfs.io, and `defaultWarm` hardcodes only `https://<id>.limo/`. So "and eth.link" is either a new gateway to add (a user-visible default change, not stated as a criterion) or dead wording that should be struck.
>
> SUGGESTED RE-SCOPE (split into three):
> 1. Reopen the `pinnace` spec (`specs/tasked/ -> specs/ready/`) and reconcile stories 9 + 15 to the ENS-demotion model (identity decoupled from ENS; warming driven by an explicit hint), per the idea note's own instruction.
> 2. Record a decision/ADR answering "how do per-site ENS hints reach the on-box warm loop", choosing among (a)-(d) above with the staleness tradeoff stated. This is the load-bearing bit: it fixes a new on-box env key / on-box state file / MFS convention that provisioned boxes will carry.
> 3. THEN a small task implementing the four-case resolution (`explicit non-empty > "" opt-out > .eth inference > nothing`) at the warm seam over whatever channel (2) chose, test-first, with the `""`-vs-undefined distinction (note `resolveConfig` already preserves it: `sites: file.sites ?? []` copies site entries verbatim, so only a test is needed there), plus an explicit yes/no on eth.link.
>
> If the owner instead wants something shippable NOW, the task must be rewritten to NAME the channel (my read: option (a), `WARM_ENS_NAMES` in `/etc/pinnace-node.env` + a `provision` input, accepting the re-provision-to-change staleness) and to say that `pinnace provision` starts carrying site-derived data — a change I will not make silently under a task whose criteria never mention `provision` or cloud-init.

<!-- q3 fields: id=q3 kind=stuck -->

**Your answer** (write below this line):
