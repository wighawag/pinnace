---
title: '`install-ci` emits a workflow the CLI cannot execute: its env contract (`IPFS_API`/`IPFS_TOKEN`/`SITE_NAME`) is read by nothing'
slug: install-ci-emits-a-workflow-the-cli-cannot-execute
status: fixed
source: 'Read 2026-07-31 at 4a77748: `src/ci/ci-emit.ts` (renderGithubWorkflow + ALL_SETTINGS) vs `src/config/config-resolution.ts` (resolveConfig/resolveHostToken/resolveMasterSecret) and `src/cli/run.ts` (runDeploy, runInstallCi). Confirmed by running `node dist/cli/bin.js install-ci --system github --build-command "pnpm build mainnet" --output-dir web/build --node-version 22` and grepping: `IPFS_API|IPFS_TOKEN|SITE_NAME|SITE_MODE` occur ONLY in ci-emit.ts and its test, nowhere in the config/CLI layers.'
---

## The finding

The GitHub workflow `pinnace install-ci` emits would FAIL on its first run against any repo, for four independent reasons. It was ported from a reference Action (its own JSDoc says so) and snapshot-tested as a STRING, so nothing ever checked it against the CLI it invokes.

### 1. The env contract is dead

The emitted deploy step sets:

```yaml
env:
  IPFS_API: ${{ vars.IPFS_API }}
  IPFS_TOKEN: ${{ secrets.IPFS_TOKEN }}
  SITE_NAME: ${{ vars.SITE_NAME }}
  SITE_MODE: ${{ vars.SITE_MODE || 'ipns' }}
run: |
  npx pinnace deploy --set-mode "$SITE_MODE" "<outputDir>" "$SITE_NAME"
```

`pinnace deploy` reads NONE of `IPFS_API`, `IPFS_TOKEN`, `SITE_NAME`. Its host tier is `--endpoint` / `pinnace.json` / `PINNACE_HOST_<NAME>_ENDPOINT`, and its token tier is `PINNACE_HOST_<NAME>_TOKEN` (env-only). So in a repo with no committed `pinnace.json` the run dies on `NO_HOSTS_HINT` with zero hosts; with a committed `pinnace.json` it dies on the missing per-host token instead. `$SITE_NAME` also expands to the empty string unless the operator set that var, which makes the site-id positional vanish and turns the command into a usage error.

The report printed beside the workflow names the same four dead settings, so an operator who follows it exactly still cannot deploy. Only `SITE_MODE` happens to work, and only because it is passed as a CLI flag rather than read from the env.

### 2. The summary reads outputs nothing writes

```yaml
echo "- CID:  \`${{ steps.deploy.outputs.cid }}\`"
```

The deploy step never writes `$GITHUB_OUTPUT` (`pinnace deploy` prints a human line to stdout and sets no outputs), so every run's job summary renders empty backticks and a `https://.ipfs.dweb.link/` preview link. This is the second, independent half of the same untested-against-reality gap.

### 3. npm is hard-coded

`cache: npm` + `npm ci` are emitted unconditionally, with no package-manager knob. pnpm/yarn repos (including the one this was going to be installed into, which is pnpm 10 with a `packageManager` field and needs `pnpm/action-setup` BEFORE `setup-node`) must hand-edit the file, which quietly reclassifies the emitted workflow from "installable" to "starting point".

### 4. `install-ci` does not install

`runInstallCi` PRINTS the workflow to stdout. The module JSDoc says "the CLI wrapper is what writes the file to `.github/workflows/`" and the verb is named `install-ci`, but nothing touches the filesystem. Either the name/JSDoc or the behaviour is wrong; today the operator must redirect the output themselves, and the printed first line (`workflow: .github/workflows/pinnace-deploy.yml`) would land in the file if they redirect naively.

## Why it stayed invisible

`emitCi` is pure and snapshot-locked: the test asserts the emitted STRING, so the snapshot is only ever compared to itself. Nothing in the suite asserts that the env var names in the workflow are the ones the config layer reads, that the step id's outputs exist, or that the emitted YAML even parses. A pure emitter is the right shape, but its snapshot pins the wrong contract: the workflow's real counterparty is `resolveConfig` + `runDeploy`, not a golden file.

## What was decided (2026-07-31, same day)

All four defects are fixed, and the design question below was answered the FIRST way: the emitted pipeline speaks pinnace's own surface, with no CI-only env contract at all.

- INFRASTRUCTURE IS ARGS. The nodes are baked into the generated YAML as literal `--endpoint` / `--replica-endpoint` args and the site id as a literal positional, because endpoints and site ids are not secrets and belong in a diffable file rather than a CI settings panel. The only repo secrets left are the bearer tokens, under the CLI's ordinary `PINNACE_HOST_<NAME>_TOKEN` names.
- The multi-node gap that forced the choice: `--endpoint` took ONE url and `--host-endpoint.<name>` can only override hosts a file already declares, so args-only CI could reach a single node, and a replica's `mirror` timer replicates the signed RECORD and never the content. An args-only pipeline would therefore have left every replica serving the previous CID. So the CLI grew `--replica-endpoint <url>` (global, repeatable, publisher-first ordering, refused without `--endpoint`), synthesising `replica-1`, `replica-2`, ... whose tokens follow the same naming rule with no special case.
- ONE DEPLOY STEP, SHARED. Both emit targets render a `uses:` of a composite action shipped in this repo at `actions/deploy`, which owns the `pinnace deploy --json` call, the step outputs and the summary. The generated YAML therefore cannot drift from the CLI, and `deploy` grew the `--json` it needed to have real outputs at all.
- IT DOES NOT OWN THE BUILD. `--emit steps` renders the deploy step alone, to paste after whatever an existing workflow already does (the case that motivated this: a pnpm monorepo with `ldenv`, a build arg and PR previews). The full-workflow target keeps the build to `--package-manager` + `--build-command` instead of a hardcoded `npm ci`. The output dir stays STATED, never auto-detected.
- `install-ci` now installs when asked (`--write`, refusing to clobber without `--force`) and still prints by default.
- The acceptance test that was missing now exists: `test/cli/install-ci.test.ts` takes the argv the emitted step really runs and feeds it to the REAL `run()` against recording mock Kubo nodes, with ONLY the secrets the emitted report names present in the env. The emitter tests also parse the emitted YAML and check every input it passes against the composite action's declared inputs.

## What a fix has to decide

Not just a re-render, because there is a genuine design choice underneath:

- EITHER the workflow speaks pinnace's own env contract directly (`PINNACE_HOST_PUBLISHER_ENDPOINT` / `PINNACE_HOST_PUBLISHER_TOKEN`, one pair per host, plus the site id as a literal argument), which is honest but makes the multi-node case a variable-name-per-host sprawl in the GitHub settings panel;
- OR the CLI grows the compact CI-shaped contract the workflow already assumes (`IPFS_API`/`IPFS_TOKEN` as comma-separated, publisher-first lists that synthesise hosts named `publisher`, `replica-1`, ...), which keeps CI setup to two values but adds a second host-resolution surface to `config-resolution` that must not drift from the first.

The `--set-mode` flag already proves the second style is not needed for everything: values the CLI can take as arguments do not need an env alias at all. And whichever is chosen, the pipeline needs an acceptance test that RUNS the emitted workflow's deploy line against the mock Kubo, so the emitter can never again pass while naming variables nobody reads.
