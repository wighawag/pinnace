# CLI client-wrapper build decisions (2026-07-24)

Decisions recorded while building `cli-command-wrapper` (the thin client CLI). Captured here per the work contract because each touches another task/flag or sets a user-visible surface, so a reviewer/human should be able to ratify or reverse them. Not a new domain concept — these sit at the existing `core vs cli` layer.

## 1. `RunContext` / `ClientDeps` injectable seam (new, but layer-consistent)

`run()` gained an optional second arg `RunContext { env?, loadConfigFile?, deps?, out?, err? }`; `deps` is a `ClientDeps` bundle of the core functions each verb calls. Defaults read the real `process.env`, `./pinnace.json`, `console`, and the real core, so production behaviour is unchanged; tests inject in-memory values. This DELIBERATELY mirrors the already-established `NodeCommandOps` injectable-ops pattern (node-commands) and the explicit-`env` resolver arg (config-resolution) rather than inventing a new idiom. It is what makes the CLI dispatch unit-testable without a process and keeps the operator's real env/config untouched (WORK-CONTRACT shared-write rule). Touches: nothing else re-exports these types today; if the `node`/`site` namespaces later want the same testable dispatch they should reuse this same `RunContext`, not fork a second seam.

## 2. `derive` is the primary verb, `ipns-id` an accepted alias

The task/spec name it "a derive/print command" / "derive/ipns-id command". Chose `derive` as the primary verb (matches the core `deriveIpnsId`) and accept `ipns-id` as an alias so either spelling works. Alternative considered: only one spelling. Touches: help text / any docs that name the verb. Reversible (drop the alias) with no data impact.

## 3. `deploy` mode resolution: `--mode` arg > matching `pinnace.json` site entry; error if neither

`deploy <dir> <site>` takes the site's `mode` from `--mode` if given, else the matching site entry's `mode` in `pinnace.json`. If neither yields `ipfs`/`ipns` it ERRORS (loud refusal) rather than defaulting. This is a user-visible refusal, chosen over silently defaulting to `ipns`, because deploying under the wrong addressing model is the kind of mistake that is expensive to unwind (an unintended `ipns` publish vs an `ipfs`-only land). Note the CI emitter's workflow separately defaults `SITE_MODE` to `ipns` (ci-emit.ts) — that default lives in the emitted workflow env, NOT here; the CLI verb itself does not invent a mode. Touches: the `--mode` flag and the `SITE_MODE` default in ci-emitter-github. If a default is later wanted, it should be decided jointly with that CI default so the two surfaces agree.

## 4. Per-host CLI token/endpoint override flag shape

For the arg tier of config precedence, per-host overrides use `--host-token.<name> <value>` and `--host-endpoint.<name> <value>`, and `--gateways a,b` replaces the gateway list — mapping onto the existing `CliOverrides { hostToken, hostEndpoint, gateways }` shape from config-resolution (no new precedence logic in the CLI). Alternative considered: a positional or repeated `--token` (ambiguous across multiple hosts). Touches: the config-resolution `CliOverrides` contract (reused as-is). Reversible.
