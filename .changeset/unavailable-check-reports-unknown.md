---
'pinnace': minor
---

Stop `status` reporting a failed check as a confident negative. A live box reported `announced=false` for a site the delegated router was, at that moment, listing correctly: the providers lookup had failed (`if (!res.ok) return {Providers: []}` flattened a rate-limit 429 into an empty provider list), and a failed lookup was indistinguishable from a real negative. The two gateway probes had the same shape — a probe that could not be MADE was recorded exactly like a gateway that answered and did not serve.

All THREE external checks (`announced`, the CID-gateway probe, the eth.limo probe) are now three-valued: `yes` / `no` / `unknown` WITH the reason (`http 429`, `fetch failed`, `no peer id`). Only a check that ANSWERED reports a negative; a non-2xx from the routing endpoint, a thrown network/DNS/parse error, and an unidentifiable node all report `unknown`. A gateway that ANSWERS a non-2xx is still a real `no` (it told us it does not serve); only an unmakeable probe is `unknown`. The eth.limo column keeps its NOT-APPLICABLE state (a site that resolves no ENS name) DISTINCT from `unknown`: "nothing to check" and "could not check" are different answers.

Surfaces: the CLI line prints `announced=unknown (http 429)` (a check that ran keeps its `true`/`false` tokens, and `n/a` still means no eth.limo name); the dashboard renders unknown as a NEUTRAL `unknown (<reason>)` instead of the red cross, and a check the report did not run at all reads `unknown` too rather than `no`; the per-site `ok`/`unverified` roll-up treats unknown as `unverified` (never `ok`, never a failure).

Breaking for direct consumers of the report shape: `SiteStatus`/`SiteOutcome`/`StatusPageSite` `announced`, `gatewayServes` and `ethLimoServes` — and the `status.json` payload keys of the same names — carry `{state: 'yes' | 'no' | 'unknown', reason?}` instead of a boolean (new `CheckOutcome` vocabulary, exported with `checkAnswer`/`checkUnknown`/`isYes`/`checkState`/`CheckUnavailableError`). `gatewayHttp`/`ethLimoHttp` are unchanged. The error policy is unchanged: no check throws, and `status` still renders fully when every external call fails.
