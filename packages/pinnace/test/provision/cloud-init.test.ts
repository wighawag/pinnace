import {describe, it, expect} from 'vitest';
import {
	provision,
	hetznerHostProvider,
	HOST_PROVIDERS,
	type ProvisionInput,
} from '../../src/provision/cloud-init.js';

/**
 * The cloud-init generator is a PURE function of its input (no filesystem, no
 * network, no SSH): it returns the ready-to-paste cloud-init file (path +
 * contents) for a given host/site/role config. The CLI wrapper (`provision`
 * command) is what writes it to disk / hands it to the operator. That boundary
 * keeps these unit tests hermetic (assert the STRING, snapshot-locked, and the
 * security invariants).
 *
 * The seam under test is `HostProvider`: only host-specific provisioning lives
 * behind it. Deploy/publish/status stay host-agnostic (they speak only Kubo
 * RPC), so this module must NOT be reachable from them (user story 21: add a
 * host later without touching them).
 */

/** A representative publisher box config: the common case. */
function baseInput(overrides: Partial<ProvisionInput> = {}): ProvisionInput {
	return {
		host: 'hetzner',
		apiDomain: 'ipfs-api.example.com',
		dashboardDomain: 'ipfs-status.example.com',
		acmeEmail: 'you@example.com',
		bearerToken: 'a-long-random-secret',
		role: 'publisher',
		...overrides,
	};
}

describe('provision: HostProvider seam', () => {
	it('emits Hetzner cloud-init as the first (v1) implementation', () => {
		const result = provision(baseInput());
		expect(result.host).toBe('hetzner');
		expect(result.cloudInit.path).toBe('cloud-init.yaml');
		expect(result.cloudInit.contents.startsWith('#cloud-config')).toBe(true);
	});

	it('lists exactly `hetzner` as the only v1 host', () => {
		expect(HOST_PROVIDERS).toEqual(['hetzner']);
	});

	it('rejects an unimplemented host loudly (the seam exists, impls do not)', () => {
		expect(() => provision(baseInput({host: 'digitalocean' as never}))).toThrow(
			/digitalocean/i,
		);
	});

	it('hetznerHostProvider is the same generator reachable directly via the seam', () => {
		const viaSeam = hetznerHostProvider.provision(baseInput());
		const viaDispatch = provision(baseInput());
		expect(viaSeam.cloudInit.contents).toBe(viaDispatch.cloudInit.contents);
	});

	it('is deterministic: same input -> byte-identical output', () => {
		const a = provision(baseInput()).cloudInit.contents;
		const b = provision(baseInput()).cloudInit.contents;
		expect(a).toBe(b);
	});
});

describe('provision: security invariants', () => {
	it('opens swarm port 4001 on BOTH TCP and UDP', () => {
		const {contents} = provision(baseInput()).cloudInit;
		expect(contents).toContain('ufw allow 4001/tcp');
		expect(contents).toContain('ufw allow 4001/udp');
	});

	it('opens 443 (HTTPS API) but NEVER exposes 5001 raw or 8080 raw', () => {
		const {contents} = provision(baseInput()).cloudInit;
		expect(contents).toContain('ufw allow 443/tcp');
		// The RPC API (5001) and gateway (8080) must never appear in a ufw rule.
		expect(contents).not.toMatch(/ufw allow 5001/);
		expect(contents).not.toMatch(/ufw allow 8080/);
		// And the API/gateway are bound to localhost only.
		expect(contents).toContain('/ip4/127.0.0.1/tcp/5001');
		expect(contents).toContain('/ip4/127.0.0.1/tcp/8080');
	});

	it('injects the bearer token into the Kubo API.Authorizations (enforced even on localhost)', () => {
		const {contents} = provision(
			baseInput({bearerToken: 'super-secret-token'}),
		).cloudInit;
		expect(contents).toContain('super-secret-token');
		expect(contents).toContain('API.Authorizations');
	});

	it('sets the discoverability flags: AcceleratedDHTClient + reprovide + Routing.Type auto', () => {
		const {contents} = provision(baseInput()).cloudInit;
		expect(contents).toContain('Routing.AcceleratedDHTClient');
		expect(contents).toContain('Routing.Type');
		expect(contents).toMatch(/Routing\.Type[^\n]*auto/);
		expect(contents).toContain('Reprovider.Interval');
		expect(contents).toContain('Reprovider.Strategy');
	});

	it('runs Kubo as a hardened systemd unit (dedicated user + sandboxing)', () => {
		const {contents} = provision(baseInput()).cloudInit;
		expect(contents).toContain('/etc/systemd/system/ipfs.service');
		expect(contents).toContain('NoNewPrivileges=true');
		expect(contents).toContain('ProtectSystem=strict');
	});

	it('configures Caddy HTTPS + bearer API reverse proxy to localhost 5001', () => {
		const {contents} = provision(baseInput()).cloudInit;
		expect(contents).toContain('reverse_proxy 127.0.0.1:5001');
		expect(contents).toContain('ipfs-api.example.com');
	});
});

describe('provision: pinnace install + role-gated timers (NOT bash)', () => {
	it('INSTALLS the pinnace binary on the box', () => {
		const {contents} = provision(baseInput()).cloudInit;
		// pinnace is installed (npm global); the box runs the same binary.
		expect(contents).toMatch(/npm install -g pinnace|npm i -g pinnace/);
	});

	it('does NOT embed the reference bash loop scripts', () => {
		const {contents} = provision(baseInput()).cloudInit;
		expect(contents).not.toContain('ipfs-warm.sh');
		expect(contents).not.toContain('ipfs-ipns-publish.sh');
		expect(contents).not.toContain('ipfs-ipns-mirror.sh');
		expect(contents).not.toContain('ipfs-status.sh');
	});

	it('schedules all four `pinnace node` verbs on systemd timers', () => {
		const {contents} = provision(baseInput()).cloudInit;
		expect(contents).toContain('pinnace node republish');
		expect(contents).toContain('pinnace node mirror');
		expect(contents).toContain('pinnace node warm');
		expect(contents).toContain('pinnace node status');
		// Each has a .timer enabled at boot.
		expect(contents).toContain('pinnace-republish.timer');
		expect(contents).toContain('pinnace-mirror.timer');
		expect(contents).toContain('pinnace-warm.timer');
		expect(contents).toContain('pinnace-status.timer');
	});

	it('sets NODE_ROLE from config so the pinnace timers self-gate', () => {
		const pub = provision(baseInput({role: 'publisher'})).cloudInit;
		const rep = provision(baseInput({role: 'replica'})).cloudInit;
		expect(pub.contents).toContain('NODE_ROLE="publisher"');
		expect(rep.contents).toContain('NODE_ROLE="replica"');
	});

	it('carries the replica publisher endpoint into the env file', () => {
		const {contents} = provision(
			baseInput({
				role: 'replica',
				publisherEndpoint: 'https://ipfs-status-a.example.com',
			}),
		).cloudInit;
		expect(contents).toContain('NODE_ROLE="replica"');
		expect(contents).toContain(
			'PUBLISHER_ENDPOINT="https://ipfs-status-a.example.com"',
		);
	});
});

describe('provision: full cloud-init snapshot (publisher)', () => {
	it('snapshots the emitted cloud-init for a publisher box', () => {
		const result = provision(
			baseInput({
				apiDomain: 'ipfs-api.example.com',
				dashboardDomain: 'ipfs-status.example.com',
				acmeEmail: 'you@example.com',
				bearerToken: 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET',
				role: 'publisher',
				gateways: [
					'https://{cid}.ipfs.dweb.link/',
					'https://ipfs.io/ipfs/{cid}',
				],
			}),
		);
		expect(result.cloudInit.contents).toMatchSnapshot();
	});
});
