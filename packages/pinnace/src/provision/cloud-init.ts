/**
 * The **cloud-init generator** behind the `HostProvider` seam (CONTEXT.md `host
 * provider seam`). `provision` asks the core for a ready-to-paste cloud-init:
 * the host-specific YAML that stands up a hardened Kubo node. Hetzner is the
 * FIRST (and, in v1, only) implementation; other hosts are Out of Scope but
 * slot in behind this same seam later (spec "Out of Scope"; user stories 1, 21).
 *
 * This module is PURE: {@link provision} takes a plain host/site/role config
 * and returns the cloud-init file (path + contents) as data. It does NOT touch
 * the filesystem, the network, or SSH. The CLI wrapper (`provision` command)
 * is what hands the YAML to the operator. Keeping the emit pure lets it be
 * snapshot-tested as a string with no fixtures (test-first policy) and reused
 * as a TypeScript API (CONTEXT.md `core vs cli`).
 *
 * SEAM DISCIPLINE (user story 21): only host-specific provisioning lives behind
 * `HostProvider`. Deploy/publish/status speak ONLY Kubo RPC and must not import
 * this module. Adding a host later touches nothing but this file + the
 * {@link HOST_PROVIDERS} registry. (The dependency direction is one-way: this
 * module may reference the shared `HostRole` type, but nothing in deploy/
 * publish/status references this module.)
 *
 * KEY CHANGE FROM THE REFERENCE (docs/adr/0002-on-box-agent-boundary.md): the
 * emitted cloud-init does NOT bake the reference's four bash scripts
 * (`ipfs-warm.sh`, `ipfs-ipns-publish.sh`, `ipfs-ipns-mirror.sh`,
 * `ipfs-status.sh`). Instead it INSTALLS the `pinnace` binary on the box and
 * schedules the on-box subcommands (`pinnace node republish|mirror|warm|
 * status`) on role-gated systemd timers. One codebase runs both as the
 * operator's client and as the box's periodic agent, so the record/warm/mirror/
 * status logic has a single implementation (no bash/TS drift). Kubo still owns
 * pinning (`dag/import --pin-roots`) + provider-record freshness
 * (`Provide.Strategy`); the pinnace timers own ONLY IPNS republish/export,
 * replica mirror/fallback, gateway warm, and status. The reference bash is used
 * here as the BEHAVIOURAL SPEC of what each timer must do, not as code to emit.
 *
 * INVARIANTS ENCODED (ported, not copied, from `~/searches/ipfs-hetzner/`):
 *  - Kubo as a hardened systemd unit (dedicated `ipfs` user, sandboxing).
 *  - ufw opens 4001 TCP+UDP (swarm, so gateways can dial) + 80/443 (Caddy/ACME);
 *    the RPC API (5001) and gateway (8080) are bound to localhost and NEVER
 *    opened in the firewall.
 *  - discoverability: AcceleratedDHTClient + `Routing.Type auto` + reprovide
 *    (interval well under the record-expiry window, strategy `all`).
 *  - Caddy HTTPS reverse proxy for the RPC API (auto TLS), which forwards the
 *    operator's bearer header straight through to the token-guarded Kubo API.
 *
 * INSTALL CHANNEL + BOOT-SAFETY (task `cloud-init-pinnace-install-channel`):
 *  - The box installs a PINNED `pinnace` ({@link DEFAULT_PINNACE_VERSION}) on a
 *    named current Node LTS ({@link DEFAULT_NODE_MAJOR}), both overridable per
 *    box. Pinned (never floating `latest`) so a boot is reproducible.
 *  - The install is BOOT-SAFE: `pinnace-setup.sh` is invoked with `|| true`, so
 *    a transient npm/registry failure can NOT abort the boot. Kubo, the
 *    firewall and Caddy come up regardless of the agent install.
 *  - The dedicated `ipfs` service user is created by cloud-init's `users:`
 *    module, which runs BEFORE `runcmd`, so no boot step can hit "invalid user
 *    'ipfs'" (closes the first-boot race in
 *    work/notes/observations/cloud-init-first-boot-ipfs-user-race-and-set-e-abort.md).
 */
import type {HostRole} from '../config/config-resolution.js';

/** The hosts pinnace can provision for. v1 = Hetzner ONLY. */
export type HostName = 'hetzner';

/** The hosts, in a stable order (help text / iteration / validation). */
export const HOST_PROVIDERS: readonly HostName[] = ['hetzner'];

/**
 * The per-box inputs the generator injects into the cloud-init (the values
 * `make-cloud-init.sh` used to `sed` in). Everything that varies per box lives
 * here; the hardened invariants are baked into the template.
 */
export interface ProvisionInput {
	/** Which host to provision for (v1: `hetzner`). */
	host: HostName;
	/** DNS A-record pointed at this box, used for the HTTPS RPC API vhost. */
	apiDomain: string;
	/** Optional read-only status dashboard vhost (also serves exported records). */
	dashboardDomain?: string;
	/** Email for Let's Encrypt (ACME) certificate issuance. */
	acmeEmail: string;
	/**
	 * The long random bearer token guarding the RPC API. Kubo enforces it via
	 * `API.Authorizations` even on localhost; Caddy forwards the header through.
	 */
	bearerToken: string;
	/**
	 * This box's role. `publisher` holds IPNS keys and signs/exports records;
	 * `replica` is keyless and mirrors the publisher's records. Written to the
	 * env file as `NODE_ROLE`, which the `pinnace node` timers self-gate on
	 * (republish only on publisher, mirror only on replica), so scheduling all
	 * timers on every box is safe.
	 */
	role: HostRole;
	/**
	 * REPLICA ONLY: base URL to fetch the publisher's exported signed records
	 * from (the publisher's dashboard vhost). Ignored for publishers.
	 */
	publisherEndpoint?: string;
	/**
	 * Browser origins allowed to call the RPC API (CORS). Space-separated in the
	 * env file. Defaults to the dashboard domain's URL when a dashboard is set.
	 */
	corsOrigins?: string;
	/**
	 * Public gateways to warm through, each a template containing `{cid}`.
	 * Defaults to a sensible dweb.link/ipfs.io set. `.eth` MFS names are ALSO
	 * warmed via eth.limo automatically by `pinnace node warm`.
	 */
	gateways?: string[];
	/** The Kubo version to install. Defaults to a pinned known-good release. */
	kuboVersion?: string;
	/**
	 * The `pinnace` version to install on the box (`npm install -g
	 * pinnace@<this>`). Defaults to {@link DEFAULT_PINNACE_VERSION} (the current
	 * published release). PINNED, never floating `latest`, so a box boot is
	 * reproducible. Overridable per-box (e.g. to roll a box onto a newer agent).
	 */
	pinnaceVersion?: string;
	/**
	 * The Node.js major version to install via NodeSource (`setup_<this>.x`).
	 * Defaults to {@link DEFAULT_NODE_MAJOR} (a current active LTS). A named knob
	 * so the LTS bump is one obvious edit, not a literal buried in a shell line.
	 */
	nodeMajor?: string;
	/** The MFS directory sites live under. Defaults to `/sites`. */
	sitesDir?: string;
}

/** A single emitted file: where it goes + what it contains. */
export interface EmittedFile {
	/** The path to write the file at (relative; the operator pastes/uploads it). */
	path: string;
	/** The full file contents. */
	contents: string;
}

/** What a host provider returns: the ready-to-paste cloud-init file. */
export interface ProvisionResult {
	/** Which host this was provisioned for (echoed for the caller). */
	host: HostName;
	/** The cloud-init file (path + contents). */
	cloudInit: EmittedFile;
}

/**
 * The `HostProvider` seam: one method that generates a host's provisioning
 * artifact (cloud-init) for a given input. v1 has a single implementation
 * ({@link hetznerHostProvider}); adding DigitalOcean / others later means
 * adding another provider here and an entry in {@link HOST_PROVIDERS}; deploy/
 * publish/status logic is untouched (spec user story 21).
 */
export interface HostProvider {
	/** The host this provider provisions for. */
	readonly host: HostName;
	/** Generate the cloud-init (+ any host artifacts) for the given input. */
	provision(input: ProvisionInput): ProvisionResult;
}

/** Defaults kept in one place so the template + docs never drift. */
const DEFAULT_KUBO_VERSION = 'v0.38.1';
/**
 * The pinned `pinnace` version the box installs (`npm install -g
 * pinnace@<this>`). Mirrors {@link DEFAULT_KUBO_VERSION}: a NAMED knob, not a
 * literal, so a release bump is one obvious edit here. PINNED (never floating
 * `latest`) so a box boot is reproducible: the same cloud-init always installs
 * the same agent. Overridable per-box via {@link ProvisionInput.pinnaceVersion}.
 * `pinnace@0.1.0` is the first published release (npm, public, OIDC provenance).
 */
const DEFAULT_PINNACE_VERSION = '0.4.0';
/**
 * The pinned Node.js major the box installs via NodeSource (`setup_<this>.x`).
 * Node 22 is a current active LTS; Node 20 (the old literal) is the OLDEST LTS
 * (EOL ~2026-04) and incoherent with the repo's own Node 24 toolchain. A NAMED
 * knob (mirrors {@link DEFAULT_KUBO_VERSION}) so the LTS bump is one edit.
 * Overridable per-box via {@link ProvisionInput.nodeMajor}.
 */
const DEFAULT_NODE_MAJOR = '22';
const DEFAULT_SITES_DIR = '/sites';
const DEFAULT_GATEWAYS: readonly string[] = [
	'https://{cid}.ipfs.dweb.link/',
	'https://{cid}.ipfs.cf-ipfs.com/',
	'https://ipfs.io/ipfs/{cid}',
];

/**
 * One `pinnace node` verb scheduled on a systemd timer. The verb self-gates on
 * `NODE_ROLE` (republish -> publisher, mirror -> replica) or is role-agnostic
 * (warm/status), so scheduling ALL of them on EVERY box is safe: the
 * wrong-role verb is a clean no-op (ADR-0002).
 */
interface TimerSpec {
	/** The `pinnace node <verb>` this timer runs. */
	verb: 'republish' | 'mirror' | 'warm' | 'status';
	/** Human description for the unit files. */
	description: string;
	/** `OnBootSec` for the timer (staggered so timers don't all fire at once). */
	onBootSec: string;
	/** `OnUnitActiveSec`, the recurring cadence. */
	onUnitActiveSec: string;
}

/**
 * The four timers, ported from the reference bash-unit cadences but pointed at
 * `pinnace node <verb>` instead of the bash scripts (ADR-0002). Order is stable
 * (deterministic output). Cadences mirror the reference: IPNS republish/mirror
 * well under record expiry, warm/status more frequent.
 */
const TIMERS: readonly TimerSpec[] = [
	{
		verb: 'republish',
		description: 'Republish + export IPNS records (publisher role)',
		onBootSec: '8min',
		onUnitActiveSec: '6h',
	},
	{
		verb: 'mirror',
		description: 'Mirror publisher IPNS records (replica role)',
		onBootSec: '9min',
		onUnitActiveSec: '3h',
	},
	{
		verb: 'warm',
		description: 'Warm public IPFS gateway caches for our CIDs',
		onBootSec: '5min',
		onUnitActiveSec: '30min',
	},
	{
		verb: 'status',
		description: 'Regenerate the per-site status page + JSON for the dashboard',
		onBootSec: '6min',
		onUnitActiveSec: '15min',
	},
];

/** Render the `pinnace-<verb>` systemd service + timer unit pair. */
function renderTimerUnits(t: TimerSpec): string {
	return `  - path: /etc/systemd/system/pinnace-${t.verb}.service
    permissions: "0644"
    owner: root:root
    content: |
      [Unit]
      Description=${t.description}
      After=ipfs.service

      [Service]
      Type=oneshot
      User=ipfs
      Group=ipfs
      EnvironmentFile=/etc/pinnace-node.env
      Environment=IPFS_PATH=/var/lib/ipfs/.ipfs
      # Resolve the pinnace bin via PATH rather than a hardcoded prefix: npm's
      # global prefix is /usr on a nodesource install (bin at /usr/bin/pinnace),
      # but /usr/local on others. /usr/bin/env + an explicit PATH covers both, so
      # the unit does not 203/EXEC on a prefix mismatch.
      Environment=PATH=/usr/local/bin:/usr/bin:/bin
      ExecStart=/usr/bin/env pinnace node ${t.verb}

  - path: /etc/systemd/system/pinnace-${t.verb}.timer
    permissions: "0644"
    owner: root:root
    content: |
      [Unit]
      Description=Schedule pinnace node ${t.verb}

      [Timer]
      OnBootSec=${t.onBootSec}
      OnUnitActiveSec=${t.onUnitActiveSec}
      Persistent=true

      [Install]
      WantedBy=timers.target
`;
}

/**
 * Render the full Hetzner cloud-init. Deterministic: same input -> byte-
 * identical output (snapshot-locked). Encodes the hardened-node invariants
 * (ufw 4001 TCP+UDP + 443, never 5001 raw; localhost-bound API/gateway;
 * AcceleratedDHTClient + reprovide + `Routing.Type auto`; hardened systemd
 * Kubo unit; Caddy HTTPS + bearer proxy) and schedules the `pinnace node`
 * timers (NOT bash).
 */
function renderHetznerCloudInit(input: ProvisionInput): string {
	const dashboardDomain = input.dashboardDomain ?? '';
	const corsOrigins =
		input.corsOrigins ?? (dashboardDomain ? `https://${dashboardDomain}` : '');
	const publisherEndpoint =
		input.role === 'replica' ? (input.publisherEndpoint ?? '') : '';
	const gateways = input.gateways ?? DEFAULT_GATEWAYS;
	const kuboVersion = input.kuboVersion ?? DEFAULT_KUBO_VERSION;
	const pinnaceVersion = input.pinnaceVersion ?? DEFAULT_PINNACE_VERSION;
	const nodeMajor = input.nodeMajor ?? DEFAULT_NODE_MAJOR;
	const sitesDir = input.sitesDir ?? DEFAULT_SITES_DIR;
	const warmGateways = gateways.join(' ');

	const timerUnits = TIMERS.map(renderTimerUnits).join('\n');
	const enableTimers = TIMERS.map(
		(t) => `  - systemctl enable --now pinnace-${t.verb}.timer`,
	).join('\n');

	return `#cloud-config
# =============================================================================
# ${input.host} Cloud -> self-hosted IPFS (Kubo) node for a static website.
#
# Generated by \`pinnace provision --host ${input.host}\`. This is the programmatic
# successor to the shell \`sed\`-template prototype (superseded).
#
# What this gives you:
#   - Kubo running as a hardened systemd service (user: ipfs)
#   - Swarm port 4001 (TCP+UDP) open so public gateways can dial you
#   - RPC API (5001) bound to localhost, exposed ONLY via Caddy HTTPS + bearer
#   - AcceleratedDHTClient + reprovide tuned so gateways can DISCOVER your node
#   - The \`pinnace\` binary installed + its on-box subcommands
#     (\`pinnace node republish|mirror|warm|status\`) scheduled on role-gated
#     systemd timers. Kubo owns pinning + reprovide; pinnace owns IPNS
#     republish/export, replica mirror/fallback, gateway warm, and status.
#     (See docs/adr/0002-on-box-agent-boundary.md.)
# =============================================================================

package_update: true
package_upgrade: true

packages:
  - curl
  - ca-certificates
  - ufw
  - jq
  - debian-keyring
  - debian-archive-keyring
  - apt-transport-https

# ---------------------------------------------------------------------------
# Service users. cloud-init's \`users:\` module runs BEFORE \`runcmd\`, so the
# dedicated \`ipfs\` user is GUARANTEED to exist before any boot step uses it
# (e.g. \`install -o ipfs ...\`). Creating it here (not mid-\`ipfs-setup.sh\`,
# which is a \`set -e\` block that could abort before its \`useradd\`) closes the
# first-boot race where a later step hit "invalid user 'ipfs'".
# \`default\` keeps cloud-init's normal login user; we only ADD \`ipfs\`.
# ---------------------------------------------------------------------------
users:
  - default
  - name: ipfs
    system: true
    home: /var/lib/ipfs
    shell: /usr/sbin/nologin
    lock_passwd: true

# ---------------------------------------------------------------------------
# On-box environment consumed by the pinnace node timers + the setup scripts.
# ---------------------------------------------------------------------------
write_files:
  - path: /etc/pinnace-node.env
    permissions: "0600"
    owner: root:root
    content: |
      API_DOMAIN="${input.apiDomain}"
      DASH_DOMAIN="${dashboardDomain}"
      API_CORS_ORIGINS="${corsOrigins}"
      ACME_EMAIL="${input.acmeEmail}"
      RPC_BEARER_TOKEN="${input.bearerToken}"

      # Gateways to warm through. {cid} is replaced with each site's current CID
      # by \`pinnace node warm\`, which AUTO-DISCOVERS sites from MFS (\${SITES_DIR}).
      # Any MFS entry whose name ends in .eth is ALSO warmed via eth.limo.
      WARM_GATEWAYS="${warmGateways}"

      # MFS directory that holds your sites (one entry per site).
      SITES_DIR="${sitesDir}"

      # On-box PATHS the \`pinnace node\` verbs read (they assemble their
      # NodeCommandContext from these keys):
      #   DASHBOARD_DIR  - where \`node status\` writes status.json (machine) and
      #                    index.html (the human status page served at the vhost
      #                    ROOT); the dashboard vhost \${DASH_DOMAIN} serves this
      #                    dir.
      #   RECORDS_DIR    - where \`node republish\` (publisher) EXPORTS the signed
      #                    record; UNDER the dashboard dir so it is served at
      #                    \${DASH_DOMAIN}/records/<id>.ipns-record, exactly where a
      #                    replica's PUBLISHER_ENDPOINT + /records/ fetch looks.
      #   CACHE_DIR      - where \`node mirror\` (replica) CACHES the last good
      #                    record for the publisher-outage fallback (under the
      #                    ipfs user's writable home).
      DASHBOARD_DIR="/var/www/ipfs-dash"
      RECORDS_DIR="/var/www/ipfs-dash/records"
      CACHE_DIR="/var/lib/ipfs/records-cache"

      # Role: "publisher" holds IPNS keys and signs/exports records; "replica"
      # holds NO key and MIRRORS the publisher's signed records. The pinnace node
      # timers self-gate on this, so scheduling all timers on every box is safe.
      NODE_ROLE="${input.role}"

      # REPLICA ONLY: where to fetch the publisher's exported signed records.
      PUBLISHER_ENDPOINT="${publisherEndpoint}"

      KUBO_VERSION="${kuboVersion}"

      # Node.js major installed via NodeSource (setup_<major>.x) and the PINNED
      # pinnace version installed on the box. Both are reproducible: the same
      # cloud-init always installs the same agent on the same runtime.
      NODE_MAJOR="${nodeMajor}"
      PINNACE_VERSION="${pinnaceVersion}"

  # -- Kubo installer / initializer -----------------------------------------
  - path: /usr/local/sbin/ipfs-setup.sh
    permissions: "0755"
    owner: root:root
    content: |
      #!/usr/bin/env bash
      set -euo pipefail
      source /etc/pinnace-node.env

      # cloud-init runs runcmd with NO HOME in the environment, and the ipfs
      # binary REFUSES to run without it (Error: HOME is not defined) because it
      # resolves HOME/.config/ipfs for the nopfs denylists. Under set -e that
      # aborts this script at the very first ipfs call (ipfs --version), before
      # the user/datadir/repo are set up, leaving the box crash-looping. Set a
      # default for the whole script; the per-user calls below override it with
      # the ipfs user home.
      export HOME="\${HOME:-/root}"

      ARCH="$(dpkg --print-architecture)"   # amd64 / arm64
      TARBALL="kubo_\${KUBO_VERSION}_linux-\${ARCH}.tar.gz"
      URL="https://dist.ipfs.tech/kubo/\${KUBO_VERSION}/\${TARBALL}"

      cd /tmp
      curl -fsSL "$URL" -o "$TARBALL"
      tar -xzf "$TARBALL"
      bash kubo/install.sh
      ipfs --version

      if ! id ipfs >/dev/null 2>&1; then
        useradd --system --create-home --home-dir /var/lib/ipfs --shell /usr/sbin/nologin ipfs
      fi
      install -d -o ipfs -g ipfs /var/lib/ipfs

      export IPFS_PATH=/var/lib/ipfs/.ipfs
      # HOME must be passed to every sudo -u ipfs invocation: sudo does not
      # inherit it, and the ipfs binary aborts (Error: HOME is not defined) since
      # it resolves HOME/.config/ipfs for the nopfs denylists. Without this,
      # ipfs init fails under set -e and aborts this whole script before the
      # datadir/config are set up (the box then crash-loops). Point it at the
      # ipfs user home (the datadir root).
      IPFS_HOME=/var/lib/ipfs
      if [ ! -f "$IPFS_PATH/config" ]; then
        # 'server' profile disables local-network announce (good for a datacenter box)
        sudo -u ipfs env IPFS_PATH="$IPFS_PATH" HOME="$IPFS_HOME" ipfs init --profile server
      fi

      cfg() { sudo -u ipfs env IPFS_PATH="$IPFS_PATH" HOME="$IPFS_HOME" ipfs config "$@"; }

      # --- Reachability: bind API + gateway to localhost only (NEVER public) ---
      cfg Addresses.API   "/ip4/127.0.0.1/tcp/5001"
      cfg Addresses.Gateway "/ip4/127.0.0.1/tcp/8080"

      # --- Discoverability: keep provider records fresh so gateways find us ---
      cfg --json Routing.AcceleratedDHTClient true
      cfg Routing.Type "auto"
      # Re-announce everything we serve via the Kubo 0.38 Provide.* config (the
      # pre-0.38 keys FATAL the daemon at boot). Only Provide.Strategy is set: on
      # Kubo 0.38.1 the interval sub-key is not a settable config path (ipfs
      # config errors "not found / maybe use --json" even WITH --json), and under
      # set -e that aborts this whole setup script. It is optional with a sane
      # built-in default, so we leave it unset.
      cfg Provide.Strategy "all"

      # --- Resource hygiene for a small box ---
      cfg Datastore.StorageMax "40GB"
      cfg --json Swarm.ConnMgr.HighWater 200
      cfg --json Swarm.ConnMgr.LowWater  100

      # --- RPC API auth: require a bearer token even on localhost ---
      cfg --json API.Authorizations "{
        \\"uploader\\": {
          \\"AuthSecret\\": \\"bearer:\${RPC_BEARER_TOKEN}\\",
          \\"AllowedPaths\\": [\\"/api/v0\\"]
        }
      }"

      cfg --json API.HTTPHeaders.Access-Control-Allow-Origin  "[\\"*\\"]"
      cfg --json API.HTTPHeaders.Access-Control-Allow-Methods "[\\"POST\\"]"
      cfg --json API.HTTPHeaders.Access-Control-Allow-Headers "[\\"Authorization\\"]"

      chown -R ipfs:ipfs /var/lib/ipfs

  # -- systemd unit for the daemon (hardened) -------------------------------
  - path: /etc/systemd/system/ipfs.service
    permissions: "0644"
    owner: root:root
    content: |
      [Unit]
      Description=IPFS Kubo daemon
      After=network-online.target
      Wants=network-online.target

      [Service]
      User=ipfs
      Group=ipfs
      Environment=IPFS_PATH=/var/lib/ipfs/.ipfs
      # HOME must point at the ipfs user's home (inside ReadWritePaths). Kubo's
      # nopfs plugin resolves \$HOME/.config/ipfs/denylists; with HOME unset it
      # falls back under /home/ipfs, which ProtectHome=true HIDES, so the daemon
      # dies at startup with "denylists: permission denied". Setting HOME here
      # keeps that lookup inside the writable datadir.
      Environment=HOME=/var/lib/ipfs
      # NOTE: the datadir /var/lib/ipfs is created by a runcmd step BEFORE this
      # unit is enabled (see runcmd) — NOT via ExecStartPre. ReadWritePaths=
      # /var/lib/ipfs makes systemd set up the mount namespace (referencing that
      # path) BEFORE running any Exec* line, including ExecStartPre — even an
      # ExecStartPre=+ one — so if the path is missing, namespace setup fails
      # with 226/NAMESPACE and the ExecStartPre can never create it (a catch-22).
      # The path must therefore exist before the unit starts, guaranteed outside
      # the unit.
      ExecStart=/usr/local/bin/ipfs daemon --migrate=true --enable-gc
      Restart=on-failure
      RestartSec=5
      LimitNOFILE=65536
      # hardening
      NoNewPrivileges=true
      ProtectSystem=strict
      ProtectHome=true
      ReadWritePaths=/var/lib/ipfs
      PrivateTmp=true

      [Install]
      WantedBy=multi-user.target

  # -- pinnace installer: the box runs the SAME binary as the client --------
  - path: /usr/local/sbin/pinnace-setup.sh
    permissions: "0755"
    owner: root:root
    content: |
      #!/usr/bin/env bash
      set -euo pipefail
      source /etc/pinnace-node.env
      # Install Node.js (for npm) then the PINNED pinnace binary globally. The
      # on-box timers invoke \`pinnace node <verb>\`: one codebase, client +
      # on-box. NODE_MAJOR / PINNACE_VERSION come from /etc/pinnace-node.env so
      # the runtime + agent version are reproducible and one-edit overridable.
      # This script is invoked NON-FATALLY at boot (\`|| true\`): a transient
      # npm/registry hiccup must NOT abort provisioning (Kubo, the firewall and
      # Caddy are already up by the time this runs). Re-run it manually to retry.
      if ! command -v npm >/dev/null 2>&1; then
        curl -fsSL "https://deb.nodesource.com/setup_\${NODE_MAJOR}.x" | bash -
        apt-get install -y nodejs
      fi
      npm install -g "pinnace@\${PINNACE_VERSION}"
      pinnace version

  # -- Caddy reverse proxy for the HTTPS API (auto TLS) ---------------------
  - path: /usr/local/sbin/write-caddyfile.sh
    permissions: "0755"
    owner: root:root
    content: |
      #!/usr/bin/env bash
      set -euo pipefail
      source /etc/pinnace-node.env
      if [ -z "\${API_DOMAIN}" ]; then
        echo "API_DOMAIN not set; skipping Caddy config (API stays localhost-only)."
        exit 0
      fi
      cat > /etc/caddy/Caddyfile <<EOF
      {
        email \${ACME_EMAIL}
      }

      \${API_DOMAIN} {
        @cors_preflight method OPTIONS
        header {
          Access-Control-Allow-Origin "\${API_CORS_ORIGINS}"
          Access-Control-Allow-Methods "POST, OPTIONS"
          Access-Control-Allow-Headers "Authorization, Content-Type"
          Vary Origin
        }
        respond @cors_preflight 204

        # Only the Kubo RPC API. Kubo enforces the bearer token via
        # API.Authorizations; Caddy just forwards the header.
        reverse_proxy 127.0.0.1:5001
      }
      EOF

      if [ -n "\${DASH_DOMAIN}" ]; then
      cat >> /etc/caddy/Caddyfile <<EOF

      \${DASH_DOMAIN} {
        root * /var/www/ipfs-dash
        file_server
      }
      EOF
      fi
      systemctl restart caddy

${timerUnits}
# ---------------------------------------------------------------------------
# Boot sequence
# ---------------------------------------------------------------------------
runcmd:
  # Install Caddy (official repo)
  - curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  - curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  - apt-get update
  - apt-get install -y caddy

  # Firewall: SSH + IPFS swarm + HTTP/HTTPS (for the API). NOT 5001 raw, NOT 8080.
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow 22/tcp
  - ufw allow 4001/tcp
  - ufw allow 4001/udp
  - ufw allow 80/tcp
  - ufw allow 443/tcp
  - ufw --force enable

  # Install + start Kubo.
  # Create the datadir FIRST, unconditionally, before anything that needs it.
  # This MUST happen outside the ipfs.service unit: that unit's
  # ReadWritePaths=/var/lib/ipfs makes systemd fail namespace setup
  # (226/NAMESPACE) if the path is missing, before any ExecStartPre could create
  # it. And it must not depend on ipfs-setup.sh reaching its own mkdir (that
  # script can abort early). So we guarantee it here, first.
  - install -d -o ipfs -g ipfs /var/lib/ipfs
  - /usr/local/sbin/ipfs-setup.sh
  - systemctl daemon-reload
  - systemctl enable --now ipfs.service

  # Configure the HTTPS API proxy (no-op if API_DOMAIN unset)
  - /usr/local/sbin/write-caddyfile.sh

  # Dashboard dir, owned by the ipfs service user (guaranteed to exist: created
  # by the \`users:\` module above, BEFORE runcmd). Done BEFORE the pinnace
  # install so a transient install failure can never skip it.
  - install -d -o ipfs -g ipfs /var/www/ipfs-dash

  # Install the pinned pinnace binary (the box runs the same CLI as the client).
  # BOOT-SAFE: \`|| true\` so a transient npm/registry failure does NOT abort the
  # boot (Kubo, the firewall and Caddy are already up). Re-run
  # /usr/local/sbin/pinnace-setup.sh manually to retry; the timers below pick it
  # up on their next tick once the binary is present.
  - /usr/local/sbin/pinnace-setup.sh || true

  # Enable the pinnace node timers. republish self-gates to publisher, mirror to
  # replica, so enabling all of them on every box is safe (ADR-0002).
${enableTimers}

# =============================================================================
# NOTES
# -----
# 1. DNS: point an A record (API_DOMAIN) at this box's IPv4 BEFORE first boot,
#    or re-run /usr/local/sbin/write-caddyfile.sh after DNS propagates.
# 2. Verify discoverability from OUTSIDE the box after ~15 min:
#       https://delegated-ipfs.dev/routing/v1/providers/<CID>
#    Your PeerID should appear in the providers list.
# =============================================================================
`;
}

/**
 * The Hetzner provider: the first implementation of {@link HostProvider}.
 * Emits the hardened-node cloud-init to a conventional filename.
 */
export const hetznerHostProvider: HostProvider = {
	host: 'hetzner',
	provision(input: ProvisionInput): ProvisionResult {
		return {
			host: 'hetzner',
			cloudInit: {
				path: 'cloud-init.yaml',
				contents: renderHetznerCloudInit(input),
			},
		};
	},
};

/** The provider registry (host -> provider). v1 has a single entry. */
const PROVIDERS: Record<HostName, HostProvider> = {
	hetzner: hetznerHostProvider,
};

/**
 * Generate the provisioning cloud-init for the requested host: dispatches to
 * the matching {@link HostProvider} and returns its cloud-init file. Throws
 * LOUDLY on an unknown/unimplemented host (the seam exists so callers can add
 * hosts later, but v1 only ships `hetzner`): never a silent no-op.
 */
export function provision(input: ProvisionInput): ProvisionResult {
	const provider = PROVIDERS[input.host];
	if (!provider) {
		throw new Error(
			`unsupported host '${input.host}'; v1 provisions only ${HOST_PROVIDERS.join(
				', ',
			)} (other hosts are Out of Scope but the HostProvider seam exists)`,
		);
	}
	return provider.provision(input);
}
