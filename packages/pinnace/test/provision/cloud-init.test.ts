import {describe, it, expect} from 'vitest';
import {
	provision,
	hetznerHostProvider,
	HOST_PROVIDERS,
	type ProvisionInput,
} from '../../src/provision/cloud-init.js';
import {PINNACE_VERSION} from '../../src/version.js';

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

/**
 * A FIXED FAKE agent pin, injected by every test whose output is asserted or
 * snapshotted. The DEFAULT pin is now DERIVED from the package version, so
 * baking the real one into a snapshot would turn every changesets bump into a
 * red suite on main (trading a once-per-release manual edit for a
 * once-per-release build break). The default is asserted separately, by
 * comparing against the shared source ({@link PINNACE_VERSION}), never a
 * literal.
 */
const FAKE_PINNACE_VERSION = '9.9.9';

/** A representative publisher box config: the common case. */
function baseInput(overrides: Partial<ProvisionInput> = {}): ProvisionInput {
	return {
		host: 'hetzner',
		apiDomain: 'ipfs-api.example.com',
		dashboardDomain: 'ipfs-status.example.com',
		acmeEmail: 'you@example.com',
		bearerToken: 'a-long-random-secret',
		role: 'publisher',
		pinnaceVersion: FAKE_PINNACE_VERSION,
		...overrides,
	};
}

/** The same config with NO pin stated, so the DERIVED default is exercised. */
function inputWithoutPin(
	overrides: Partial<ProvisionInput> = {},
): ProvisionInput {
	const {pinnaceVersion: _stated, ...rest} = baseInput(overrides);
	return rest;
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
		expect(contents).toContain('Provide.Strategy');
		// Provide.Interval is NOT settable on Kubo 0.38.1 (ipfs config errors even
		// with --json) and, under set -e, would abort the setup script. It is
		// optional with a built-in default, so the generator must NOT run a
		// `cfg ... Provide.Interval` command (a comment mentioning it is fine).
		expect(contents).not.toMatch(/cfg[^\n]*Provide\.Interval/);
		// The datadir must be created in runcmd (outside the unit) BEFORE the
		// ipfs.service is enabled: the unit's ReadWritePaths=/var/lib/ipfs makes
		// systemd fail namespace setup (226/NAMESPACE) if the path is missing,
		// before any ExecStartPre could create it (a catch-22). So there must be a
		// runcmd `install -d ... /var/lib/ipfs` and it must NOT be an ExecStartPre.
		expect(contents).toMatch(/- install -d -o ipfs -g ipfs \/var\/lib\/ipfs/);
		expect(contents).not.toMatch(/ExecStartPre=[^\n]*\/var\/lib\/ipfs/);
		// HOME must be set in the daemon unit: Kubo's nopfs plugin reads
		// $HOME/.config/ipfs/denylists, and with HOME unset it falls back under
		// /home/ipfs which ProtectHome=true hides -> "denylists: permission denied"
		// crash. HOME=/var/lib/ipfs keeps it inside the writable datadir.
		expect(contents).toMatch(/Environment=HOME=\/var\/lib\/ipfs/);
		// EVERY `sudo -u ipfs env ... ipfs ...` call in the setup script MUST pass
		// HOME: sudo does not inherit it, and `ipfs init`/`ipfs config` abort with
		// "Error: HOME is not defined", which under set -e aborts the whole setup
		// script before the datadir/config exist (fresh box then crash-loops).
		for (const m of contents.matchAll(/sudo -u ipfs env ([^\n]*?) ipfs\b/g)) {
			expect(m[1]).toMatch(/HOME=/);
		}
		// (and there is at least one such call, so the loop above is meaningful)
		expect(contents).toMatch(/sudo -u ipfs env [^\n]*HOME=[^\n]* ipfs/);
		// The setup script must also export a HOME for its ROOT-run ipfs calls
		// (e.g. `ipfs --version`): cloud-init's runcmd has no HOME, and the ipfs
		// binary refuses to run without one, aborting the script under set -e at
		// the very first call — before the user/datadir/repo exist.
		expect(contents).toMatch(/export HOME=/);
	});

	// Kubo 0.38 (the pinned DEFAULT_KUBO_VERSION) renamed `Reprovider.*` ->
	// `Provide.*` and FATALs at startup if any deprecated `Reprovider` key is
	// present. The emitted config MUST use the new keys and MUST NOT contain any
	// `Reprovider` key at all, otherwise the provisioned daemon crash-loops. See
	// work/notes/observations/cloud-init-deprecated-reprovider-fatal-on-kubo-0-38.md.
	it('emits Provide.Strategy (Kubo 0.38 key) and NEVER any deprecated Reprovider key', () => {
		const {contents} = provision(baseInput()).cloudInit;
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
		const {contents} = provision(inputWithoutPin()).cloudInit;
		// The pinned version is exposed as a named env value, not a literal in the
		// install line.
		expect(contents).toMatch(/PINNACE_VERSION="\d+\.\d+\.\d+[^"]*"/);
		// The install line references the pin, NOT a bare floating `pinnace`.
		expect(contents).toContain('npm install -g "pinnace@${PINNACE_VERSION}"');
		expect(contents).not.toMatch(/npm install -g pinnace\s*$/m);
		// EXACT, never a floating tag or a range.
		expect(contents).not.toMatch(/PINNACE_VERSION="(?:latest|[\^~*])/);
	});

	it('DERIVES the default pin from the CLI own version (no hand-edited literal)', () => {
		// The box must install the agent matching the CLI that emitted its
		// cloud-init. Asserted by comparison against the shared source of truth,
		// NOT a literal: a changesets bump must never redden this suite (that is
		// the drift this task closes, see
		// work/notes/observations/cloud-init-version-pin-trails-the-release.md).
		const {contents} = provision(inputWithoutPin()).cloudInit;
		expect(contents).toContain(`PINNACE_VERSION="${PINNACE_VERSION}"`);
	});

	it('is REPRODUCIBLE for a given build: the derived pin does not vary per call', () => {
		const a = provision(inputWithoutPin()).cloudInit.contents;
		const b = provision(inputWithoutPin()).cloudInit.contents;
		expect(a).toBe(b);
	});

	it('lets a box pin a different pinnace version (overridable provision input)', () => {
		// The per-box override still wins over the derived default: a box can be
		// rolled onto another agent version without rebuilding the CLI.
		const {contents} = provision(
			baseInput({pinnaceVersion: '1.2.3-rc.4'}),
		).cloudInit;
		expect(contents).toContain('PINNACE_VERSION="1.2.3-rc.4"');
		expect(contents).not.toContain(`PINNACE_VERSION="${PINNACE_VERSION}"`);
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
		// The unit must resolve the bin via PATH (/usr/bin/env pinnace), NOT a
		// hardcoded prefix: nodesource npm installs to /usr/bin/pinnace, so a
		// hardcoded /usr/local/bin/pinnace 203/EXECs the timer.
		expect(contents).toMatch(/ExecStart=\/usr\/bin\/env pinnace node/);
		expect(contents).not.toMatch(/\/usr\/local\/bin\/pinnace/);
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
				// Explicit FAKE pin: the snapshot must never bake the real package
				// version (a bump would redden it on main).
				pinnaceVersion: FAKE_PINNACE_VERSION,
				gateways: [
					'https://{cid}.ipfs.dweb.link/',
					'https://ipfs.io/ipfs/{cid}',
				],
			}),
		);
		expect(result.cloudInit.contents).toMatchSnapshot();
	});
});

describe('provision: optional self-hosted PATH gateway (--gateway-domain)', () => {
	const GW = 'ipfs-gw.example.com';

	it('WITHOUT a gateway domain: no gateway vhost, no NoFetch, no GATEWAY_DOMAIN, gateway stays localhost', () => {
		const {contents} = provision(baseInput()).cloudInit;
		expect(contents).not.toContain('GATEWAY_DOMAIN');
		expect(contents).not.toContain('Gateway.NoFetch');
		expect(contents).not.toContain('reverse_proxy 127.0.0.1:8080');
		expect(contents).toContain(
			'cfg Addresses.Gateway "/ip4/127.0.0.1/tcp/8080"',
		);
	});

	it('WITH a gateway domain: records it in the env file', () => {
		const {contents} = provision(baseInput({gatewayDomain: GW})).cloudInit;
		expect(contents).toContain(`GATEWAY_DOMAIN="${GW}"`);
	});

	it('WITH a gateway domain: sets Gateway.NoFetch=true (never an open proxy)', () => {
		const {contents} = provision(baseInput({gatewayDomain: GW})).cloudInit;
		expect(contents).toMatch(/cfg --json Gateway\.NoFetch true/);
	});

	it('WITH a gateway domain: emits a third Caddy vhost proxying ONLY /ipfs/ and /ipns/ to 127.0.0.1:8080', () => {
		const {contents} = provision(baseInput({gatewayDomain: GW})).cloudInit;
		expect(contents).toContain('${GATEWAY_DOMAIN} {');
		expect(contents).toContain('@content path /ipfs/* /ipns/*');
		expect(contents).toContain('reverse_proxy 127.0.0.1:8080');
		expect(contents).toContain('respond 404');
	});

	it('keeps the gateway bound to localhost and 8080 unopened even when exposed', () => {
		const {contents} = provision(baseInput({gatewayDomain: GW})).cloudInit;
		expect(contents).toContain(
			'cfg Addresses.Gateway "/ip4/127.0.0.1/tcp/8080"',
		);
		expect(contents).not.toMatch(/ufw allow 8080/);
	});

	it('never mounts the gateway under the dashboard (or API) hostname', () => {
		expect(() =>
			provision(baseInput({gatewayDomain: 'ipfs-status.example.com'})),
		).toThrow(/dashboard/i);
		expect(() =>
			provision(baseInput({gatewayDomain: 'IPFS-API.example.com'})),
		).toThrow(/api/i);
	});

	it('refuses a gateway domain that is not a bare hostname', () => {
		for (const bad of [
			'https://gw.example.com',
			'gw.example.com/x',
			'gw "x"',
			'',
		]) {
			expect(() => provision(baseInput({gatewayDomain: bad}))).toThrow(
				/gateway domain/i,
			);
		}
	});

	it('works on a replica too (serving is role-agnostic)', () => {
		const {contents} = provision(
			baseInput({role: 'replica', gatewayDomain: GW}),
		).cloudInit;
		expect(contents).toContain(`GATEWAY_DOMAIN="${GW}"`);
		expect(contents).toContain('reverse_proxy 127.0.0.1:8080');
	});

	it('snapshots the emitted cloud-init with a gateway', () => {
		const result = provision(
			baseInput({
				bearerToken: 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET',
				gatewayDomain: GW,
				gateways: ['https://{cid}.ipfs.dweb.link/'],
			}),
		);
		expect(result.cloudInit.contents).toMatchSnapshot();
	});
});

describe('provision: in-place reprovision script (update a live box without recreating it)', () => {
	/** Every `install -m <mode> -o <u> -g <g> "$STAGE<path>" <path>` line, keyed by path. */
	function installs(script: string): Map<string, string> {
		const m = new Map<string, string>();
		for (const x of script.matchAll(
			/^install -m (\d+) -o (\S+) -g (\S+) "\$STAGE(\S+)" (\S+)$/gm,
		)) {
			expect(x[4]).toBe(x[5]);
			m.set(x[5], `${x[1]} ${x[2]}:${x[3]}`);
		}
		return m;
	}

	/** The staged body of one file (between its heredoc markers). */
	function staged(script: string, path: string): string {
		const start = `stage ${path} <<'PINNACE_BOX_FILE_EOF'\n`;
		const i = script.indexOf(start);
		expect(i).toBeGreaterThan(-1);
		const from = i + start.length;
		const end = script.indexOf('\nPINNACE_BOX_FILE_EOF\n', from);
		return script.slice(from, end + 1);
	}

	it('is returned beside the cloud-init, as a bash script', () => {
		const {reprovisionScript} = provision(baseInput());
		expect(reprovisionScript.path).toBe('reprovision.sh');
		expect(reprovisionScript.contents.startsWith('#!/usr/bin/env bash\n')).toBe(
			true,
		);
		expect(reprovisionScript.contents).toContain('set -euo pipefail');
	});

	it('writes EXACTLY the files the cloud-init writes, with the same contents/modes/owners', () => {
		const input = baseInput({gatewayDomain: 'ipfs-gw.example.com'});
		const {cloudInit, reprovisionScript} = provision(input);
		const script = reprovisionScript.contents;
		const yamlPaths = [
			...cloudInit.contents.matchAll(/^  - path: (\S+)$/gm),
		].map((m) => m[1]);
		const inst = installs(script);
		expect([...inst.keys()]).toEqual(yamlPaths);
		for (const path of yamlPaths) {
			// mode/owner identical to the cloud-init entry
			const entry = new RegExp(
				`  - path: ${path.replace(/[.]/g, '\\.')}\\n    permissions: "(\\d+)"\\n    owner: (\\S+)\\n`,
			).exec(cloudInit.contents)!;
			expect(inst.get(path)).toBe(`${entry[1]} ${entry[2]}`);
			// contents identical to the cloud-init content block, de-indented
			const body = staged(script, path);
			const indented = body
				.split('\n')
				.map((l) => (l === '' ? l : `      ${l}`))
				.join('\n');
			expect(cloudInit.contents).toContain(`    content: |\n${indented}`);
		}
	});

	it('is root-only and refuses to run on a box that was never provisioned', () => {
		const script = provision(baseInput()).reprovisionScript.contents;
		expect(script).toContain('id -u');
		expect(script).toContain('/etc/pinnace-node.env');
		expect(script).toContain('/var/lib/ipfs/.ipfs/config');
	});

	it('refuses a NODE_ROLE or bearer-token change unless explicitly allowed', () => {
		const script = provision(baseInput()).reprovisionScript.contents;
		expect(script).toContain('PINNACE_ALLOW_ROLE_CHANGE');
		expect(script).toContain('PINNACE_ALLOW_TOKEN_CHANGE');
	});

	it('supports a dry run that applies nothing, and never prints the bearer token', () => {
		const script = provision(baseInput({bearerToken: 'super-secret-token'}))
			.reprovisionScript.contents;
		const dry = script.indexOf('PINNACE_DRY_RUN');
		expect(dry).toBeGreaterThan(-1);
		// The dry-run exit comes BEFORE the first install.
		expect(dry).toBeLessThan(script.indexOf('\ninstall -m '));
		expect(script).toContain('RPC_BEARER_TOKEN=<masked>');
	});

	it('stops Kubo for the config step and ALWAYS restarts it (trap), then re-applies Caddy, agent and timers', () => {
		const script = provision(baseInput()).reprovisionScript.contents;
		const order = [
			'systemctl stop ipfs.service',
			'/usr/local/sbin/ipfs-setup.sh',
			'systemctl start ipfs.service',
			'/usr/local/sbin/write-caddyfile.sh',
			'/usr/local/sbin/pinnace-setup.sh',
			'systemctl enable --now pinnace-status.timer',
		].map((s) => script.indexOf(`\n${s}`));
		for (const i of order) expect(i).toBeGreaterThan(-1);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(script).toMatch(
			/trap '[^']*systemctl start ipfs\.service[^']*' EXIT/,
		);
	});

	it('skips the Kubo download when the pinned version is installed, and falls back to the GitHub release otherwise', () => {
		// A live reprovision hit a dist.ipfs.tech outage: re-downloading an
		// already-installed Kubo must not depend on that host being up.
		const {contents} = provision(baseInput()).cloudInit;
		expect(contents).toContain(
			'if [ "$(ipfs --version 2>/dev/null || true)" = "ipfs version ${KUBO_VERSION#v}" ]; then',
		);
		expect(contents).toContain(
			'https://github.com/ipfs/kubo/releases/download/${KUBO_VERSION}/${TARBALL}',
		);
		expect(contents).toMatch(/curl -fsSL --connect-timeout \d+ --max-time \d+/);
	});

	it('does NOT touch the firewall, the packages, or the Kubo repo contents', () => {
		const script = provision(baseInput()).reprovisionScript.contents;
		expect(script).not.toMatch(/^ufw /m);
		expect(script).not.toMatch(/^apt-get /m);
		expect(script).not.toMatch(/rm -rf \/var\/lib\/ipfs/);
	});

	it('snapshots the reprovision script', () => {
		const result = provision(
			baseInput({
				bearerToken: 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET',
				gatewayDomain: 'ipfs-gw.example.com',
				gateways: ['https://{cid}.ipfs.dweb.link/'],
			}),
		);
		expect(result.reprovisionScript.contents).toMatchSnapshot();
	});
});
