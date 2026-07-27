/**
 * The two eth.limo RESOLUTION AXES — `origin` ("is the name pointing at THIS
 * site?") and `freshness` ("is it serving our CURRENT cid?") — read from the
 * `x-ipfs-path` / `x-ipfs-roots` headers the eth.limo probe already receives.
 *
 * WHY: `status` could answer only "does `<name>.limo` respond?"
 * ({@link ../status/status-report.js#SiteStatus.ethLimoServes}). A live box
 * answered YES, with every other indicator green, while eth.limo was serving
 * through a DIFFERENT publisher's name:
 *
 *   x-ipfs-path:  /ipns/k51qzi5uqu5dlu1ien9spji7pu49mfw97mn0qv4azugqcvenj0dvzq9bgwp1zc/
 *   x-ipfs-roots: bafybeiepw4aijr4dtlhth2xkzskxaxcjvtk6neqsd6zua7rfv6m5nbkesu
 *
 * The operator had pinned that content with `pin --from-ipns` and never
 * repointed the ENS contenthash, so pinnace was republishing an ORPHANED name
 * nothing referenced: the site would go dark the day the old publisher stopped
 * refreshing. The bytes were ours (the roots header IS our cid); the NAME was
 * not. That is why the two axes are INDEPENDENT and never collapsed into one
 * verdict.
 *
 * HONESTY — what this actually measures (read this before quoting it at an
 * operator): these axes observe WHAT ETH.LIMO RESOLVED AND SERVED, through its
 * OWN cache. They are NOT a read of the ENS record. So they can lag reality,
 * and they cannot distinguish "the contenthash is wrong" from "eth.limo cached
 * an older resolution". They answer exactly one question — "what is eth.limo
 * serving for this name, and does it come from us?" — and must never be worded
 * as having read ENS. Reading ENS would need an Ethereum RPC, deliberately out
 * of scope (CONTEXT.md: wiring a name into ENS is the consumer's job).
 *
 * Consequences of that honesty, all deliberate:
 *  - a `stale` freshness shortly after a deploy is NORMAL IPNS-propagation /
 *    gateway-cache lag, NOT a fault, and every renderer shows it as a neutral
 *    attention state — never the red negative;
 *  - a `foreign` origin on an `ipfs`-mode site may simply be an OLDER cid of
 *    the operator's own (an `ipfs` contenthash must be repointed per deploy),
 *    which is indistinguishable from another site's cid from out here;
 *  - cids are compared as STRINGS, exactly as the node's `files/stat` and the
 *    gateway spell them. A different encoding of the SAME cid (v0 `Qm...` vs
 *    v1 `bafy...`) therefore reads as `stale` rather than `current` — which is
 *    why `stale` is an attention state and not an accusation.
 *
 * This is a pure LEAF (its only import is the sibling reason-normaliser in
 * {@link ./check-outcome.js}): headers in, two verdicts out. No clock, no
 * network, no core imports — so the dashboard renderer
 * ({@link ./status-html.js}), which must stay free of core imports, can render
 * these axes, and the classification is unit-testable on the exact header pair
 * the live box produced.
 *
 * Design decisions (what `frozen` means, why origin does not fold freshness in)
 * are recorded in
 * `work/notes/observations/ethlimo-origin-and-freshness-decisions.md`.
 */
import {shortReason} from './check-outcome.js';

/**
 * Does the ENS name resolve through THIS site's identity? FOUR states, plus
 * ABSENT at the call site meaning NOT APPLICABLE (the site resolves no ENS
 * name at all, so there is nothing to ask about — kept distinct from `unknown`
 * exactly as the eth.limo column already does).
 *
 *  - `ours`    — the path references the site's own ipns id (a site that
 *    publishes a name) or its own cid (an `ipfs`-addressed site),
 *  - `foreign` — it references some OTHER name/cid, NAMED in `path`: that name
 *    is the actionable detail, since the operator must see the wrong target to
 *    fix their ENS record,
 *  - `frozen`  — the site publishes a NAME, but ENS holds an IMMUTABLE
 *    `/ipfs/<cid>`: even when that cid is the current one, the record will
 *    never follow a future deploy,
 *  - `unknown` — we could not ask (no header, an unreadable header, no ipns id
 *    on this node to compare against, or the probe never happened), WITH the
 *    reason. Never a confident negative (`CONTEXT.md` `## Conventions`).
 */
export type EthLimoOrigin =
	/** The path references this site's own identity. */
	| {state: 'ours'}
	/** It references something else; `path` is the normalised `/ipns|ipfs/<value>`. */
	| {state: 'foreign'; path: string}
	/** A name-publishing site whose ENS holds an immutable `/ipfs/<cid>`. */
	| {state: 'frozen'; path: string}
	/** We could not ask; `reason` says why. */
	| {state: 'unknown'; reason: string};

/**
 * Is the root eth.limo served OUR CURRENT cid? THREE states (ABSENT again
 * meaning not-applicable at the call site):
 *
 *  - `current` — `x-ipfs-roots` names the site's cid,
 *  - `stale`   — it names a DIFFERENT root, carried in `servedCid`. This is
 *    NORMAL shortly after a deploy (IPNS propagation, gateway cache): an
 *    attention state, never a failure,
 *  - `unknown` — no header, an empty header, or no probe, WITH the reason.
 */
export type EthLimoFreshness =
	/** The served root is the site's current cid. */
	| {state: 'current'}
	/** A different root is being served; `servedCid` is what eth.limo answered with. */
	| {state: 'stale'; servedCid: string}
	/** We could not ask; `reason` says why. */
	| {state: 'unknown'; reason: string};

/** The two axes together — always reported as a pair, never merged. */
export interface EthLimoResolution {
	/** Does the name resolve through this site's identity? */
	origin: EthLimoOrigin;
	/** Is the served root this site's current cid? */
	freshness: EthLimoFreshness;
}

/** What {@link classifyEthLimoResolution} needs to judge one site's probe. */
export interface EthLimoResolutionInput {
	/** The site's current content root cid (`files/stat` on its wrapper's `content`). */
	cid: string;
	/**
	 * The site's IPNS id on THIS node (from `key/list`), when it holds the key.
	 * Absent on a replica (or a publisher that never imported the key), which is
	 * an `unknown` origin for a name-publishing site — not a `foreign` one.
	 */
	ipns?: string;
	/**
	 * The `mode` the site STORES in its metadata, as stored (absent stays
	 * absent). Absent is NOT read as the `ipfs` default here: like `republish`
	 * (`../publisher/record-sequence.ts`), a mode-less site with a key on this
	 * node is treated as publishing its name, because that is what the box
	 * actually does with it.
	 */
	mode?: 'ipfs' | 'ipns';
	/**
	 * The ENS name that was probed, used ONLY to spot a gateway echoing it back
	 * as the path (see {@link ECHOED_ENS_NAME_REASON}).
	 */
	ensName?: string;
	/**
	 * The response headers the probe saw, keyed by header name (lower-case as
	 * `fetch` yields them; read case-insensitively regardless).
	 */
	headers?: Readonly<Record<string, string>>;
}

/** The gateway header naming what the URL resolved to (`/ipns/<id>`, `/ipfs/<cid>`). */
const IPFS_PATH_HEADER = 'x-ipfs-path';

/** The gateway header naming the DAG root(s) it served (comma-separated). */
const IPFS_ROOTS_HEADER = 'x-ipfs-roots';

/** The `origin` reason when the gateway answered with the ENS name, not a resolved target. */
const ECHOED_ENS_NAME_REASON = 'gateway echoed the ens name';

/** The canonical `ours` origin (no detail to carry: it is our own identity). */
const ORIGIN_OURS: EthLimoOrigin = Object.freeze({state: 'ours'});

/** The canonical `current` freshness. */
const FRESHNESS_CURRENT: EthLimoFreshness = Object.freeze({state: 'current'});

/**
 * Judge one eth.limo probe's headers on BOTH axes. Pure, total, and never
 * throwing: anything it cannot read becomes an `unknown` WITH a reason, because
 * a check that could not run must not report a negative.
 *
 * The two axes are computed INDEPENDENTLY and deliberately so: the live
 * regression is precisely a `foreign` origin serving a `current` cid, and
 * folding them into one verdict would have hidden it behind a green root.
 */
export function classifyEthLimoResolution(
	input: EthLimoResolutionInput,
): EthLimoResolution {
	return {
		origin: classifyOrigin(input),
		freshness: classifyFreshness(input),
	};
}

/**
 * Both axes as `unknown` with ONE reason — the shape for a probe that could not
 * be MADE at all (eth.limo unreachable, DNS, TLS). The probe told us nothing
 * about either question, so neither may read as a negative.
 */
export function unknownEthLimoResolution(reason: string): EthLimoResolution {
	const short = shortReason(reason);
	return {
		origin: {state: 'unknown', reason: short},
		freshness: {state: 'unknown', reason: short},
	};
}

/** Does this site publish a NAME? Stored `ipfs` never does; absent falls back to key presence. */
function publishesName(input: EthLimoResolutionInput): boolean {
	if (input.mode === 'ipfs') return false;
	return input.mode === 'ipns' || input.ipns !== undefined;
}

/** The `origin` axis: what does the resolved path REFERENCE, and is it ours? */
function classifyOrigin(input: EthLimoResolutionInput): EthLimoOrigin {
	const raw = readHeader(input.headers, IPFS_PATH_HEADER);
	if (raw === undefined) {
		return {state: 'unknown', reason: `no ${IPFS_PATH_HEADER} header`};
	}
	const parsed = parseIpfsPath(raw);
	if (!parsed) {
		return {state: 'unknown', reason: `unreadable ${IPFS_PATH_HEADER} header`};
	}
	const path = `/${parsed.kind}/${parsed.value}`;

	if (parsed.kind === 'ipns') {
		if (publishesName(input)) {
			// A site that wants a name but whose id we do not know HERE: we cannot
			// compare, so we do not pretend to (a replica holds no keys).
			if (input.ipns === undefined) {
				return {
					state: 'unknown',
					reason: 'no ipns id for this site on this node',
				};
			}
			if (parsed.value === input.ipns) return ORIGIN_OURS;
		}
		// Some gateways answer with the DNSLink/ENS name itself rather than the key
		// it resolved to. That says nothing about the origin either way.
		if (echoesEnsName(parsed.value, input.ensName)) {
			return {state: 'unknown', reason: ECHOED_ENS_NAME_REASON};
		}
		return {state: 'foreign', path};
	}

	// An IMMUTABLE `/ipfs/<cid>` under a site that publishes a name: the ENS
	// record cannot follow the name, so it will not track deploys — surfaced
	// distinctly from `ours` and from `foreign`, whatever the cid happens to be
	// (whether it is the CURRENT cid is the freshness axis' question, not this
	// one, and the two stay independent).
	if (publishesName(input)) return {state: 'frozen', path};
	return parsed.value === input.cid ? ORIGIN_OURS : {state: 'foreign', path};
}

/** The `freshness` axis: is the served root the site's current cid? */
function classifyFreshness(input: EthLimoResolutionInput): EthLimoFreshness {
	const raw = readHeader(input.headers, IPFS_ROOTS_HEADER);
	if (raw === undefined) {
		return {state: 'unknown', reason: `no ${IPFS_ROOTS_HEADER} header`};
	}
	// The gateway lists one root PER PATH SEGMENT; the FIRST is the root the name
	// resolved to, which is the one "is it our cid?" is about (the rest are
	// children of it, e.g. the `index.html` a directory request resolved to).
	const servedCid = raw.split(',')[0]?.trim() ?? '';
	if (servedCid === '') {
		return {state: 'unknown', reason: `empty ${IPFS_ROOTS_HEADER} header`};
	}
	return servedCid === input.cid
		? FRESHNESS_CURRENT
		: {state: 'stale', servedCid};
}

/** Is this path value just the ENS name we asked for, echoed back? */
function echoesEnsName(value: string, ensName: string | undefined): boolean {
	if (!ensName) return false;
	return value.toLowerCase() === ensName.toLowerCase();
}

/**
 * Read a header case-insensitively. `fetch` lower-cases its header names, but a
 * hand-built probe (or a fixture transcribed from a live `curl -I`) may not,
 * and a Title-Cased header must not read as an absent one.
 */
function readHeader(
	headers: Readonly<Record<string, string>> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const direct = headers[name];
	if (direct !== undefined) return direct;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return value;
	}
	return undefined;
}

/**
 * Split an `x-ipfs-path` value into its namespace and the id/cid it names:
 * `/ipns/k51.../index.html` -> `{kind: 'ipns', value: 'k51...'}`. Anything that
 * is not one of the two known namespaces reads as UNREADABLE (an `unknown`),
 * never as a guess.
 */
function parseIpfsPath(
	raw: string,
): {kind: 'ipns' | 'ipfs'; value: string} | undefined {
	const match = /^\/(ipns|ipfs)\/([^/?#]+)/.exec(raw.trim());
	if (!match) return undefined;
	return {kind: match[1] as 'ipns' | 'ipfs', value: match[2]!};
}
