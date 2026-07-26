/**
 * The MFS **site wrapper**: the on-node layout of a site, and the codec for the
 * per-site **metadata** that travels with it.
 *
 * A site in MFS is a WRAPPER DIRECTORY, not a bare content entry:
 *
 *   /sites/<id>/content        the site's UnixFS root CID (what used to sit at
 *                              `/sites/<id>` itself)
 *   /sites/<id>/metadata.json  the per-site metadata (`ensName`, `mode`)
 *
 * The metadata lives NEXT TO the content so it travels with the site on the
 * node: the client writes it when it places the site (an operation it has the
 * information for), and the on-box loop READS it from the thing it can already
 * see — MFS — instead of a config channel the box never gets (spec
 * `sites-metadata-in-mfs`). The CONSEQUENCE of the wrapper is that every
 * content-cid reader/writer must target the `content` SUBPATH: the wrapper
 * dir's own hash is the hash of `{content, metadata.json}`, NOT the site's cid.
 * This module is the single place that knows those paths, so no caller
 * re-spells `/sites/<id>/content` (and none can drift).
 *
 * THREE-VALUED `ensName` (load-bearing, see {@link SiteMetadata}): a name, the
 * EMPTY string, and ABSENT mean three DIFFERENT things to the on-box warm rule,
 * so the codec here preserves all three exactly — `""` is written as `""` and
 * read back as `""`, while an absent field writes no key at all.
 *
 * Absence is NORMAL, never an error: a site placed before metadata existed (or
 * by an older pinnace) simply has no `metadata.json`, and reads as `{}`. But
 * absence has TWO readers with different stakes, so it has two readings here:
 * the DISCOVERY read ({@link readSiteMetadata}) is tolerant, absorbing any
 * failure into `{}` so one unreadable file cannot sink the on-box pass, while
 * the WRITE read ({@link readSiteMetadataForWrite}) establishes absence
 * POSITIVELY from a successful listing and REFUSES
 * ({@link SiteMetadataUnreadableError}) on anything it could not interpret —
 * because a write that preserves what it did not restate would otherwise
 * destroy stored state on the strength of an outage.
 *
 * This module also owns BOTH sides of that three-valued field: the WRITE side —
 * what a `deploy`/`pin` puts in `metadata.json` for each operator intent
 * ({@link EnsNameIntent}, {@link resolveSiteMetadataToWrite}), including the
 * read-modify-write that makes OMITTING the flags leave an existing name alone —
 * and the READ side, {@link resolveEnsNameToWarm}, the rule the on-box `warm`
 * loop resolves each site's eth.limo name with. `mode` travels through the SAME
 * write-side resolver ({@link SiteModeIntent}): stating it is `--set-mode`,
 * omitting it PRESERVES what the site stores, so the stored metadata — not a
 * config file, and not a flag the operator must remember — is the durable home
 * of how a site is addressed. They live together so the two
 * sides cannot drift about what `""` and ABSENT mean.
 * Decisions behind the intent shape are recorded in
 * `work/notes/observations/deploy-pin-write-site-metadata-decisions.md`, and
 * those behind the strict write-side read (and `site add` joining it) in
 * `work/notes/observations/site-metadata-write-path-decisions.md`.
 */
import type {SiteMode} from '../config/config-resolution.js';
import type {KuboRpcClient} from '../rpc/kubo-rpc-client.js';

/** The wrapper entry holding the site's UnixFS root CID. */
export const SITE_CONTENT_ENTRY = 'content';

/** The wrapper entry holding the site's per-site metadata JSON. */
export const SITE_METADATA_ENTRY = 'metadata.json';

/**
 * The per-site metadata stored at `/sites/<id>/metadata.json`.
 *
 * `ensName` — the OPTIONAL eth.limo warming lever (CONTEXT.md `ensName`), with
 * THREE distinct states the on-box warm rule resolves differently: a non-empty
 * name (warm `<ensName>.limo`), `""` (OPT OUT — never warm, even for a `.eth`
 * id), and ABSENT (INFER from a `.eth` id). `""` is therefore NEVER coerced to
 * absent, in either direction.
 *
 * `mode` — `ipfs` or `ipns` (CONTEXT.md `mode`), recorded so the box can see
 * how a site is addressed without a config file.
 *
 * BOTH fields are optional in the TYPE because this is the shape as STORED, and
 * the read side must be able to represent metadata that is absent, empty, or
 * partial (an older or hand-edited `metadata.json`) rather than invent values.
 * Every WRITE path in pinnace supplies the `mode` it is placing under.
 */
export interface SiteMetadata {
	/** The eth.limo warming hint: a name, `""` (opt out), or absent (infer). */
	ensName?: string;
	/** How the site is addressed: `ipfs` (cid) or `ipns` (stable name). */
	mode?: SiteMode;
}

/**
 * What ONE operation (a `deploy` / a `pin`) says about the site's `ensName` —
 * the WRITE-side counterpart of the three-valued field above. It is an INTENT,
 * not a value, because the fourth case (the operator said nothing) can only be
 * resolved against what the site already carries:
 *
 *  - `set`      (`--set-ens-name <name>`) — warm `<name>.limo`. The name is NOT
 *    required to be `.eth`, nor is the id: the operator is naming the gateway
 *    to warm, and the ENS name is decoupled from the site identity.
 *  - `infer`    (bare `--set-ens-name`) — REMOVE the key so the on-box rule
 *    infers the name from a `.eth` id. Requires a `.eth` id (see
 *    {@link assertEnsNameIntent}): there is nothing to infer otherwise.
 *  - `unset`    (`--unset-ens-name`) — persist `""`, the opt-out (never warm,
 *    even a `.eth` id).
 *  - `preserve` (BOTH flags omitted, the DEFAULT) — leave the field exactly as
 *    it is: absent on a first write, unchanged on a re-write. Omitting is not
 *    deleting, and it never AUTHORS a name (a `.eth` site warms by INFERENCE,
 *    with the field still absent).
 */
export type EnsNameIntent =
	/** `--set-ens-name <name>`: warm `<name>.limo`. */
	| {kind: 'set'; name: string}
	/** bare `--set-ens-name`: drop the key so a `.eth` id is inferred. */
	| {kind: 'infer'}
	/** `--unset-ens-name`: persist `""` — never warm. */
	| {kind: 'unset'}
	/** neither flag: leave whatever the site already carries. */
	| {kind: 'preserve'};

/** The intent when the caller states none: leave the site's `ensName` alone. */
export const PRESERVE_ENS_NAME: EnsNameIntent = {kind: 'preserve'};

/**
 * What ONE operation says about the site's `mode` — the same shape as
 * {@link EnsNameIntent}, with only TWO cases because `mode` has no meaningful
 * empty state an operator would author (an absent stored mode simply means
 * `ipfs`, so there is nothing for an `--unset-mode` to say):
 *
 *  - `set`      (`--set-mode ipfs|ipns`) — run in, and record, that mode.
 *  - `preserve` (the flag omitted, the DEFAULT) — run in the mode the site is
 *    ALREADY stored under, so a re-deploy/re-pin of a published site keeps
 *    signing its name instead of silently demoting it to `ipfs`.
 */
export type SiteModeIntent =
	/** `--set-mode <m>`: run in (and record) exactly this mode. */
	| {kind: 'set'; mode: SiteMode}
	/** the flag omitted: keep whatever the site already stores. */
	| {kind: 'preserve'};

/** The intent when the caller states no mode: keep the site's stored one. */
export const PRESERVE_SITE_MODE: SiteModeIntent = {kind: 'preserve'};

/**
 * The mode of a site that stores NONE — the last tier of the resolution order
 * `--set-mode` > stored `metadata.json` > this. `ipfs` is the conservative half
 * of the pair (land + pin + MFS; it mints no name and signs nothing), so a
 * FIRST deploy/pin never invents a published name, while a site that already
 * has one keeps it (that is the `preserve` tier's job, not this one's).
 */
export const DEFAULT_SITE_MODE: SiteMode = 'ipfs';

/**
 * The intent a caller's OPTIONAL stated mode expresses: a value is a `set`, an
 * omitted one is a `preserve`. This is the ONE place an undefined `mode` is
 * given its meaning, so `deploy`, `pin` and the CLI cannot drift about it.
 */
export function siteModeIntent(mode?: SiteMode): SiteModeIntent {
	return mode === undefined ? PRESERVE_SITE_MODE : {kind: 'set', mode};
}

/**
 * A bare `--set-ens-name` (the INFER intent) was asked for on a site whose `id`
 * does not end in `.eth`, so there is NOTHING to infer: removing the key would
 * leave the site with no eth.limo warming at all. A loud usage error rather
 * than a silent no-op, so the operator learns their `--set-ens-name` needed a
 * value here.
 *
 * The `.eth` requirement is specific to this ONE intent: an explicit
 * `--set-ens-name <name>` names the gateway directly and needs no `.eth` id.
 */
export class EnsNameInferenceError extends Error {
	constructor(
		/** The site id that cannot infer an ENS name. */
		readonly id: string,
	) {
		super(
			`--set-ens-name with no value means "infer the ENS name from the site ` +
				`id", but '${id}' does not end in .eth so there is nothing to infer. ` +
				`Give the name explicitly (--set-ens-name <name>), opt out of ` +
				`eth.limo warming (--unset-ens-name), or omit both flags to leave the ` +
				`site's ensName unchanged`,
		);
		this.name = 'EnsNameInferenceError';
	}
}

/**
 * Check an {@link EnsNameIntent} against the site `id` BEFORE any node is
 * touched, so a refusal never leaves a half-done deploy/pin behind (the same
 * stance as `pin`'s publisher precondition). Only the `infer` intent has a
 * precondition; the other three always apply.
 *
 * @throws {EnsNameInferenceError} for a bare set on a non-`.eth` id.
 */
export function assertEnsNameIntent(intent: EnsNameIntent, id: string): void {
	if (intent.kind === 'infer' && !id.endsWith('.eth')) {
		throw new EnsNameInferenceError(id);
	}
}

/** Inputs to {@link resolveSiteMetadataToWrite}. */
export interface ResolveSiteMetadataInput {
	/** The client for the NODE this write targets (metadata is per node). */
	client: KuboRpcClient;
	/** The MFS directory sites live under (e.g. `/sites`). */
	sitesDir: string;
	/** The site `id` (its MFS wrapper dir). */
	id: string;
	/** What to do with `mode` (default: {@link PRESERVE_SITE_MODE}). */
	mode?: SiteModeIntent;
	/** What to do with `ensName` (default: {@link PRESERVE_ENS_NAME}). */
	ensName?: EnsNameIntent;
}

/**
 * The metadata a write actually carries: {@link SiteMetadata} with the `mode`
 * RESOLVED, because every write path states or resolves one (the optionality on
 * `SiteMetadata` describes what may be STORED, including by an older pinnace).
 */
export interface ResolvedSiteMetadata extends SiteMetadata {
	/** The mode this write runs in and records. */
	mode: SiteMode;
}

/**
 * Resolve the {@link SiteMetadata} a `deploy`/`pin` will WRITE for one site on
 * ONE node: the `mode` its {@link SiteModeIntent} asks for, plus the `ensName`
 * state its {@link EnsNameIntent} asks for.
 *
 * `preserve` is the only intent — of EITHER field — that READS: it does a
 * read-modify-write of `/sites/<id>/metadata.json` so a re-deploy carries the
 * existing name (or an existing `""` opt-out) and the existing MODE forward,
 * and a FIRST write (no metadata to read) leaves the name absent and falls back
 * to {@link DEFAULT_SITE_MODE}. The total intents (`set`/`unset`/`infer`) fully
 * determine their field, so a write that states BOTH skips the read rather than
 * pay for an answer it would discard. When both preserve, the ONE read answers
 * both — mode is never a second round trip.
 *
 * PER NODE, deliberately: metadata travels WITH the site on each node, so each
 * node's own `metadata.json` is what is preserved (a node that never had the
 * site starts absent, whatever its siblings hold). The `mode`, though, is ONE
 * decision for a whole fan-out: `deploy`/`pin` resolve it from the PUBLISHER —
 * the node that holds the key and actually signs — and then STATE that resolved
 * value to every other target, so nodes cannot end up disagreeing about how the
 * site is addressed.
 *
 * @throws {EnsNameInferenceError} for a bare set on a non-`.eth` id (callers
 * should {@link assertEnsNameIntent} up-front so this cannot fire mid-fan-out).
 * @throws {SiteMetadataUnreadableError} when a `preserve` intent cannot learn
 * what the site stores (the node is down, or answers 401): the write is refused
 * rather than resolved from an error it could not interpret.
 */
export async function resolveSiteMetadataToWrite(
	input: ResolveSiteMetadataInput,
): Promise<ResolvedSiteMetadata> {
	const intent = input.ensName ?? PRESERVE_ENS_NAME;
	const modeIntent = input.mode ?? PRESERVE_SITE_MODE;
	assertEnsNameIntent(intent, input.id);

	// ONE read serves BOTH preserve branches (and none at all when neither asks).
	// The STRICT read: on this destructive path a failure REFUSES rather than
	// reading as "nothing stored" (see {@link readSiteMetadataForWrite}).
	const stored =
		intent.kind === 'preserve' || modeIntent.kind === 'preserve'
			? await readSiteMetadataForWrite(input.client, input.sitesDir, input.id)
			: {};
	const mode: SiteMode =
		modeIntent.kind === 'set'
			? modeIntent.mode
			: (stored.mode ?? DEFAULT_SITE_MODE);

	if (intent.kind === 'set') return {ensName: intent.name, mode};
	if (intent.kind === 'unset') return {ensName: '', mode};
	if (intent.kind === 'infer') return {mode}; // the key stays ABSENT.
	// preserve: whatever the site already says, unchanged (absent stays absent).
	return stored.ensName === undefined
		? {mode}
		: {ensName: stored.ensName, mode};
}

/**
 * Resolve WHICH ENS name (if any) a site's eth.limo gateway warming targets —
 * the READ side of the three-valued `ensName` ({@link SiteMetadata}), used by
 * the on-box `warm` loop on the metadata it discovered from MFS.
 *
 * Four cases, in strict precedence order:
 *
 *  1. `ensName` a NON-EMPTY name -> that name (`https://<name>.limo/`). The
 *     operator named the gateway; neither the name nor the `id` need be `.eth`,
 *     and an explicit name OVERRIDES a `.eth` id.
 *  2. `ensName` `""` -> NOTHING. The opt-out, and it must be checked BEFORE the
 *     `.eth` inference or a `.eth` site could never opt out.
 *  3. `ensName` ABSENT and the `id` ends in `.eth` -> INFER the name from the
 *     id (a `.eth`-named site warms eth.limo with no configuration at all).
 *  4. `ensName` ABSENT and a non-`.eth` id -> NOTHING.
 *
 * So the METADATA is the lever and the id is only the fallback inference: the
 * identity alone no longer decides warming (spec `sites-metadata-in-mfs`).
 *
 * @returns the ENS name to warm, or `undefined` for "no eth.limo warming".
 */
export function resolveEnsNameToWarm(
	id: string,
	metadata: SiteMetadata,
): string | undefined {
	// A stated ensName is TOTAL: a name warms it, `""` opts out. Only an ABSENT
	// field falls through to the `.eth` inference.
	if (metadata.ensName !== undefined) {
		return metadata.ensName === '' ? undefined : metadata.ensName;
	}
	return id.endsWith('.eth') ? id : undefined;
}

/** The site's WRAPPER dir, `/sites/<id>` (holds content + metadata). */
export function siteWrapperPath(sitesDir: string, id: string): string {
	return `${sitesDir}/${id}`;
}

/** The site's CONTENT path, `/sites/<id>/content` — the site's cid lives here. */
export function siteContentPath(sitesDir: string, id: string): string {
	return `${siteWrapperPath(sitesDir, id)}/${SITE_CONTENT_ENTRY}`;
}

/** The site's METADATA path, `/sites/<id>/metadata.json`. */
export function siteMetadataPath(sitesDir: string, id: string): string {
	return `${siteWrapperPath(sitesDir, id)}/${SITE_METADATA_ENTRY}`;
}

/**
 * Encode metadata as the bytes of `metadata.json`: small, human-readable JSON
 * (an operator can `ipfs files read` it on the box) with a trailing newline.
 *
 * Only fields that are actually SET are written, so an ABSENT `ensName` writes
 * no key (leaving the on-box rule free to infer from a `.eth` id) while an
 * `ensName: ""` writes an explicit empty string (the opt-out).
 */
export function encodeSiteMetadata(metadata: SiteMetadata): Uint8Array {
	const record: Record<string, string> = {};
	if (metadata.ensName !== undefined) record['ensName'] = metadata.ensName;
	if (metadata.mode !== undefined) record['mode'] = metadata.mode;
	return new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Parse `metadata.json` bytes, TOLERANTLY: anything that is not a JSON object
 * (empty, truncated, hand-mangled, an array) reads as EMPTY metadata rather
 * than throwing, because a single unreadable file must never sink discovery of
 * the sites around it. Fields that are present but wrongly typed (or a `mode`
 * that is not `ipfs`/`ipns`) are dropped for the same reason — the caller then
 * sees "not set", the same as a site that never had one.
 *
 * `ensName: ""` survives (it is a valid string, and the opt-out), which is the
 * whole point of the distinction the write side preserves.
 */
export function parseSiteMetadata(bytes: Uint8Array): SiteMetadata {
	const text = new TextDecoder().decode(bytes).trim();
	if (!text) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {};
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return {};
	}
	const raw = parsed as Record<string, unknown>;
	const metadata: SiteMetadata = {};
	if (typeof raw['ensName'] === 'string') metadata.ensName = raw['ensName'];
	if (raw['mode'] === 'ipfs' || raw['mode'] === 'ipns') {
		metadata.mode = raw['mode'];
	}
	return metadata;
}

/**
 * Read a site's metadata from MFS (`files/read /sites/<id>/metadata.json`).
 *
 * A site with NO metadata is normal (placed before metadata existed, or by an
 * older pinnace), and Kubo answers a missing path with a loud non-2xx — so that
 * error is DELIBERATELY absorbed here into empty metadata. The absorption is
 * scoped to this one read; every other Kubo call stays loud.
 *
 * DECISION (accepting the absence/outage CONFLATION, for DISCOVERY ONLY) —
 * raised by the review of `kubo-client-files-read-write`: Kubo gives NO narrow
 * "no such file" signal (`filesRead` raises the same untyped `KuboRpcError` for
 * a missing path, a down node and a bad token), so a tolerant read cannot tell
 * them apart. We accept the conflation rather than sniff Kubo's error TEXT
 * (brittle across versions) or make absence a caller-visible error (which would
 * make a site with no metadata — the normal case, and every site until
 * deploy/pin write one — fail discovery). It is bounded in practice: the
 * discovery pass that calls this has ALREADY completed a `files/ls` + a
 * `files/stat` on the SAME client, so an unreachable/unauthorised node has
 * failed loudly before this read is reached; only a failure appearing mid-pass
 * reads as "no metadata".
 *
 * That acceptance is SCOPED to the tolerant caller — `discoverSites` and the
 * on-box `warm`/`republish`/`status` loop it feeds, where one unreadable file
 * must never sink the pass over the sites around it. It is WRONG on a
 * destructive WRITE path, which reads only to decide what to KEEP, so a
 * swallowed error there would overwrite stored state on a guess. Writes take
 * {@link readSiteMetadataForWrite} instead, which establishes absence
 * positively and refuses anything else. Revisit if Kubo ever exposes a typed
 * not-found (which would let both callers share one read again).
 */
export async function readSiteMetadata(
	client: KuboRpcClient,
	sitesDir: string,
	id: string,
): Promise<SiteMetadata> {
	try {
		return parseSiteMetadata(
			await client.filesRead(siteMetadataPath(sitesDir, id)),
		);
	} catch {
		// No metadata.json for this site — not an error, just nothing set.
		return {};
	}
}

/**
 * A WRITE could not learn what a site already stores, so it was REFUSED.
 *
 * Raised when the node answers neither "here is the metadata" nor a listing
 * that positively shows there is none: it is down, unreachable, or answering
 * 401 on a stale token. Refusing is the safe half of the trade — the write was
 * going to PRESERVE fields the operator did not restate, and resolving them
 * from an unreadable answer means writing `{mode: 'ipfs'}` over a published
 * site's `ipns` + `ensName` and reporting success.
 *
 * It names the SITE, the NODE and the STEP that failed, because a fan-out
 * client is otherwise anonymous and the operator has to know which box to fix.
 */
export class SiteMetadataUnreadableError extends Error {
	constructor(
		/** The site whose stored metadata could not be established. */
		readonly id: string,
		/** The node that could not answer (its Kubo RPC base URL). */
		readonly baseUrl: string,
		/** The Kubo step that failed, e.g. `files/ls /sites/blog`. */
		readonly step: string,
		/** The underlying Kubo failure. */
		cause?: unknown,
	) {
		super(
			`refusing to write metadata for site '${id}' on ${baseUrl}: could not ` +
				`establish what it already stores (${step} failed: ` +
				`${cause instanceof Error ? cause.message : String(cause)}). ` +
				`Writing now would overwrite the site's stored ensName/mode with ` +
				`values resolved from an error rather than an answer. Fix the node ` +
				`(is it up, is its token still valid?) and retry, or state the whole ` +
				`record — --set-mode plus --set-ens-name/--unset-ens-name — which ` +
				`needs no read at all.`,
			{cause},
		);
		this.name = 'SiteMetadataUnreadableError';
	}
}

/**
 * Read a site's metadata for a WRITE that will PRESERVE what it does not
 * restate — the strict counterpart of {@link readSiteMetadata}.
 *
 * The difference is what "nothing stored" is allowed to be made of. The
 * tolerant read INFERS absence from a failure — right for discovery, and
 * destructive here: a down node would resolve a no-flag re-deploy to
 * `{mode:'ipfs'}` and wipe the site's `ensName`. So absence must be POSITIVE —
 * a SUCCESSFUL listing that does not carry the file:
 *
 *  1. `files/ls` the WRAPPER. Listed `metadata.json` -> read it (and a read
 *     that then fails is an OUTAGE, never an absence). Not listed -> the site
 *     genuinely stores nothing.
 *  2. The wrapper would not list? WALK UP — the sites dir, then its parents,
 *     then the MFS root (which always exists). The first level that ANSWERS
 *     decides: if it does not carry the next segment, the path genuinely does
 *     not exist yet (a first deploy, or a fresh box with no `/sites` at all);
 *     if it DOES carry it while the level below would not answer, that is an
 *     outage wearing an absence's clothes.
 *  3. Nothing answered at all -> {@link SiteMetadataUnreadableError}.
 *
 * Kubo's error TEXT is never inspected (it is brittle across versions, and was
 * rejected for the tolerant read for the same reason); the SHAPE of a
 * successful listing is the signal. The extra round trips are deliberate:
 * `deploy`/`pin`/`site add` are not hot, and the correctness of stored state
 * beats one request.
 *
 * @throws {SiteMetadataUnreadableError} for any failure that is not a positive
 * absence.
 */
export async function readSiteMetadataForWrite(
	client: KuboRpcClient,
	sitesDir: string,
	id: string,
): Promise<SiteMetadata> {
	const metadataPath = siteMetadataPath(sitesDir, id);
	// `/sites/<id>/metadata.json` as segments, so the walk up is the same code
	// for a nested sites dir as for `/sites`.
	const segments = metadataPath.split('/').filter(Boolean);
	/** The DEEPEST step that failed — what an eventual refusal reports. */
	let failure: {step: string; cause: unknown} | undefined;

	for (let depth = segments.length - 1; depth >= 0; depth--) {
		const parent = `/${segments.slice(0, depth).join('/')}`;
		const child = segments[depth];
		let entries: string[];
		try {
			entries = await listMfsEntryNames(client, parent);
		} catch (cause) {
			// This level cannot be seen. Its PARENT may still say, positively, that
			// the path simply does not exist here.
			failure ??= {step: `files/ls ${parent}`, cause};
			continue;
		}
		// A successful listing WITHOUT the next segment: a real absence.
		if (!entries.includes(child)) return {};
		if (depth === segments.length - 1) {
			// `metadata.json` is positively THERE, so a failed read is an outage.
			try {
				return parseSiteMetadata(await client.filesRead(metadataPath));
			} catch (cause) {
				throw new SiteMetadataUnreadableError(
					id,
					client.baseUrl,
					`files/read ${metadataPath}`,
					cause,
				);
			}
		}
		// This level says the path below EXISTS, but that level would not answer.
		break;
	}

	throw new SiteMetadataUnreadableError(
		id,
		client.baseUrl,
		failure?.step ?? `files/ls ${metadataPath}`,
		failure?.cause,
	);
}

/** The entry NAMES of one MFS directory (`files/ls`), loudly on any failure. */
async function listMfsEntryNames(
	client: KuboRpcClient,
	path: string,
): Promise<string[]> {
	const listing = await client.filesLs<{
		Entries?: Array<{Name?: string}> | null;
	}>(path);
	const names: string[] = [];
	for (const entry of listing?.Entries ?? []) {
		if (entry?.Name) names.push(entry.Name);
	}
	return names;
}
