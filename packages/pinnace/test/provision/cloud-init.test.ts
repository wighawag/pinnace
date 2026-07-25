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

	it('sets the discoverability flags: AcceleratedDHTClient + Provide + Routing.Type auto', () => {
		const {contents} = provision(baseInput()).cloudInit;
		expect(contents).toContain('Routing.AcceleratedDHTClient');
		expect(contents).toContain('Routing.Type');
		expect(contents).toMatch(/Routing\.Type[^\n]*auto/);
		expect(contents).toContain('Provide.Interval');
		expect(contents).toContain('Provide.Strategy');
		// Provide.Interval is a DURATION value Kubo requires as JSON: without
		// --json the `ipfs config` call errors and, under set -e, aborts the setup
		// script (box left half-provisioned, daemon never inits). Guard the --json.
		expect(contents).toMatch(/cfg --json Provide\.Interval/);
		// The datadir must be guaranteed before the sandboxed daemon starts, or
		// ReadWritePaths=/var/lib/ipfs fails namespace setup (226/NAMESPACE).
		expect(contents).toMatch(
			/ExecStartPre=\+\/usr\/bin\/install -d -o ipfs -g ipfs \/var\/lib\/ipfs/,
		);
	});

	// Kubo 0.38 (the pinned DEFAULT_KUBO_VERSION) renamed `Reprovider.*` ->
	// `Provide.*` and FATALs at startup if any deprecated `Reprovider` key is
	// present. The emitted config MUST use the new keys and MUST NOT contain any
	// `Reprovider` key at all, otherwise the provisioned daemon crash-loops. See
	// work/notes/observations/cloud-init-deprecated-reprovider-fatal-on-kubo-0-38.md.
	it('emits Provide.* (Kubo 0.38 keys) and NEVER any deprecated Reprovider key', () => {
		const {contents} = provision(baseInput()).cloudInit;
		expect(contents).toContain('Provide.Interval');
		expect(contents).toContain('Provide.Strategy');
		expect(contents).not.toMatch(/Reprovider/);
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
		// pinnace is installed (npm global, PINNED); the box runs the same binary.
		expect(contents).toMatch(/npm install -g "pinnace@\$\{PINNACE_VERSION\}"/);
	});

	it('installs a PINNED pinnace version (never floating latest) via a named env knob', () => {
		const {contents} = provision(baseInput()).cloudInit;
		// The pinned version is exposed as a named env value, not a literal in the
		// install line, so a release bump is one obvious edit.
		expect(contents).toMatch(/PINNACE_VERSION="\d+\.\d+\.\d+"/);
		// The install line references the pin, NOT a bare floating `pinnace`.
		expect(contents).toContain('npm install -g "pinnace@${PINNACE_VERSION}"');
		expect(contents).not.toMatch(/npm install -g pinnace\s*$/m);
		// Default pin is the current published release.
		expect(contents).toContain('PINNACE_VERSION="0.3.1"');
	});

	it('lets a box pin a different pinnace version (overridable provision input)', () => {
		const {contents} = provision(
			baseInput({pinnaceVersion: '9.9.9'}),
		).cloudInit;
		expect(contents).toContain('PINNACE_VERSION="9.9.9"');
	});

	it('installs Node via a current LTS major as a named knob (not the stale setup_20.x literal)', () => {
		const {contents} = provision(baseInput()).cloudInit;
		expect(contents).toContain('NODE_MAJOR="22"');
		// NodeSource line uses the knob, and is NOT the stale Node 20 literal.
		expect(contents).toContain('setup_${NODE_MAJOR}.x');
		expect(contents).not.toContain('setup_20.x');
	});

	it('lets a box choose a different Node major (overridable provision input)', () => {
		const {contents} = provision(baseInput({nodeMajor: '24'})).cloudInit;
		expect(contents).toContain('NODE_MAJOR="24"');
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

	it('is BOOT-SAFE: the pinnace install cannot abort the boot (|| true guard)', () => {
		const {contents} = provision(baseInput()).cloudInit;
		// The runcmd invocation is guarded so a transient install failure does not
		// abort provisioning; Kubo/firewall/Caddy must come up regardless.
		expect(contents).toContain('/usr/local/sbin/pinnace-setup.sh || true');
	});

	it('creates the ipfs service user via cloud-init `users:` (BEFORE runcmd)', () => {
		const {contents} = provision(baseInput()).cloudInit;
		// The dedicated user is created by the users: module, which runs before
		// runcmd, so no boot step can hit "invalid user 'ipfs'".
		expect(contents).toMatch(/^users:/m);
		expect(contents).toContain('name: ipfs');
		// users: must appear BEFORE runcmd: in the emitted document.
		expect(contents.indexOf('\nusers:')).toBeLessThan(
			contents.indexOf('\nruncmd:'),
		);
	});

	it('creates the dashboard dir BEFORE the (non-fatal) pinnace install so it is never skipped', () => {
		const {contents} = provision(baseInput()).cloudInit;
		const dashDir = contents.indexOf(
			'install -d -o ipfs -g ipfs /var/www/ipfs-dash',
		);
		const pinnaceInstall = contents.indexOf(
			'/usr/local/sbin/pinnace-setup.sh || true',
		);
		expect(dashDir).toBeGreaterThan(-1);
		expect(pinnaceInstall).toBeGreaterThan(-1);
		expect(dashDir).toBeLessThan(pinnaceInstall);
	});

	it('sets NODE_ROLE from config so the pinnace timers self-gate', () => {
		const pub = provision(baseInput({role: 'publisher'})).cloudInit;
		const rep = provision(baseInput({role: 'replica'})).cloudInit;
		expect(pub.contents).toContain('NODE_ROLE="publisher"');
		expect(rep.contents).toContain('NODE_ROLE="replica"');
	});

	it('emits the on-box PATH keys the node verbs read (records/cache/dashboard)', () => {
		// The on-box `pinnace node` verbs assemble their NodeCommandContext from
		// /etc/pinnace-node.env: recordsDir/cacheDir/dashboardDir come from these
		// named keys. RECORDS_DIR must sit UNDER the dashboard dir so the publisher's
		// exported record lands at ${DASH_DOMAIN}/records/<id>.ipns-record, which is
		// exactly where the replica's mirror fetch (publisherEndpoint + /records/...)
		// looks. Without these keys the on-box republish/mirror timers are no-ops.
		const {contents} = provision(baseInput({role: 'publisher'})).cloudInit;
		expect(contents).toContain('DASHBOARD_DIR="/var/www/ipfs-dash"');
		expect(contents).toContain('RECORDS_DIR="/var/www/ipfs-dash/records"');
		expect(contents).toContain('CACHE_DIR="/var/lib/ipfs/records-cache"');
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
