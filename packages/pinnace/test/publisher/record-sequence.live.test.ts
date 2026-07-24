import {describe, it, expect} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import type {NodeCommandContext} from '../../src/node/node-commands.js';
import {
	republishAndExport,
	mirrorAndReannounce,
} from '../../src/publisher/record-sequence.js';

/**
 * LIVE failover smoke test (opt-in, self-skipping).
 *
 * This proves the publisher-export -> replica-fetch -> routing/put -> fallback
 * SEQUENCE against REAL Kubo daemons + a real publisher endpoint. It NEVER runs
 * in the default `verify`: it self-SKIPS unless the operator supplies real
 * endpoints + tokens via env, so it touches no live infra and gates nothing by
 * default. Any on-box path it writes is isolated to a temp fixture.
 *
 * Actually EXECUTING it against real Hetzner boxes is the separate `humanOnly`
 * `verify-ipns-failover-live` follow-up task; this file is the reproducible
 * harness that task runs. Because it is `describe.skipIf`-guarded on the env,
 * the default `pnpm test` reports it SKIPPED (never a failure, never a network
 * call).
 *
 * Required env to opt in (all must be set):
 *   PINNACE_LIVE_PUBLISHER_URL    the publisher node's Kubo RPC base URL
 *   PINNACE_LIVE_PUBLISHER_TOKEN  the publisher node's bearer token
 *   PINNACE_LIVE_REPLICA_URL      a replica node's Kubo RPC base URL
 *   PINNACE_LIVE_REPLICA_TOKEN    the replica node's bearer token
 *   PINNACE_LIVE_PUBLISHER_ENDPOINT  base URL that serves /records/<name>.*
 *   PINNACE_LIVE_SITE             a site name present under /sites on both boxes
 */

const env = process.env;
const REQUIRED = [
	'PINNACE_LIVE_PUBLISHER_URL',
	'PINNACE_LIVE_PUBLISHER_TOKEN',
	'PINNACE_LIVE_REPLICA_URL',
	'PINNACE_LIVE_REPLICA_TOKEN',
	'PINNACE_LIVE_PUBLISHER_ENDPOINT',
	'PINNACE_LIVE_SITE',
] as const;

const haveLiveEnv = REQUIRED.every((k) => !!env[k]);

// `skipIf(true)` => the whole suite is reported SKIPPED (not failed) when the
// live env is absent, so the default verify never touches real infra.
describe.skipIf(!haveLiveEnv)(
	'LIVE ipns failover smoke (opt-in via env)',
	() => {
		it('publisher exports, replica mirrors, then re-announces from cache on outage', async () => {
			const site = env.PINNACE_LIVE_SITE!;
			const dir = await mkdtemp(join(tmpdir(), 'pinnace-live-'));
			try {
				const publisher = new KuboRpcClient({
					baseUrl: env.PINNACE_LIVE_PUBLISHER_URL!,
					token: env.PINNACE_LIVE_PUBLISHER_TOKEN!,
				});
				const replica = new KuboRpcClient({
					baseUrl: env.PINNACE_LIVE_REPLICA_URL!,
					token: env.PINNACE_LIVE_REPLICA_TOKEN!,
				});

				// Discover the CID for the target site on the publisher.
				const stat = await publisher.filesStat<{Hash?: string}>(
					`/sites/${site}`,
				);
				const cid = stat?.Hash;
				expect(
					cid,
					'publisher must serve the target site under /sites',
				).toBeTruthy();
				const sites = [{id: site, cid: cid!}];

				// 1) Publisher signs + exports the raw record to an isolated records dir.
				const pubCtx: NodeCommandContext = {
					client: publisher,
					role: 'publisher',
					recordsDir: join(dir, 'records'),
				};
				const pubRes = await republishAndExport(pubCtx, sites);
				expect(pubRes.sites.find((s) => s.id === site)?.status).toBe(
					'exported',
				);

				// 2) Replica fetches the exported record and re-announces it.
				const repCtx: NodeCommandContext = {
					client: replica,
					role: 'replica',
					publisherEndpoint: env.PINNACE_LIVE_PUBLISHER_ENDPOINT!,
					cacheDir: join(dir, 'cache'),
				};
				const mirrorRes = await mirrorAndReannounce(repCtx, sites);
				expect(mirrorRes.sites.find((s) => s.id === site)?.status).toBe(
					're-announced',
				);

				// 3) Simulate a publisher outage: the replica falls back to its cache
				//    and still re-announces (the grace window).
				const downCtx: NodeCommandContext = {
					...repCtx,
					publisherFetch: async () => {
						throw new Error('simulated publisher outage');
					},
				};
				const fallbackRes = await mirrorAndReannounce(downCtx, sites);
				expect(fallbackRes.sites.find((s) => s.id === site)?.status).toBe(
					're-announced-cached',
				);
			} finally {
				await rm(dir, {recursive: true, force: true});
			}
		}, 120_000);
	},
);
