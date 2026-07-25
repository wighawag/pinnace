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
 * by an older pinnace) simply has no `metadata.json`, and reads as `{}`.
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
 * DECISION (accepting the absence/outage CONFLATION) — raised by the review of
 * `kubo-client-files-read-write`: Kubo gives NO narrow "no such file" signal
 * (`filesRead` raises the same untyped `KuboRpcError` for a missing path, a
 * down node and a bad token), so a tolerant read cannot tell them apart. We
 * accept the conflation rather than sniff Kubo's error TEXT (brittle across
 * versions) or make absence a caller-visible error (which would make a site
 * with no metadata — the normal case, and every site until deploy/pin write one
 * — fail discovery). It is bounded in practice: the discovery pass that calls
 * this has ALREADY completed a `files/ls` + a `files/stat` on the SAME client,
 * so an unreachable/unauthorised node has failed loudly before this read is
 * reached; only a failure appearing mid-pass reads as "no metadata". Revisit if
 * Kubo ever exposes a typed not-found.
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
