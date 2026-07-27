/**
 * What a site's ENS name READS AS to an operator — the one classification both
 * status renderers (the CLI `status` line and the dashboard row) share.
 *
 * The column is written from the STORED `ensName`, but it is READ as "what is
 * this site's ENS name?", and for a `.eth` site that stores none those two
 * answers differ: the stored field is absent while the box demonstrably warms
 * `<id>.limo`. Describing only the stored field made both renderers print
 * `unset`/`none` right beside a working eth.limo link — a row that contradicts
 * itself. So the display state is resolved from BOTH facts the report already
 * carries: the three-valued stored `ensName` and the ALREADY-RESOLVED
 * `ensNameToWarm` (`../site/site-wrapper.js#resolveEnsNameToWarm`, applied by
 * the report).
 *
 * This module RESOLVES NOTHING itself — it re-reads no metadata and re-applies
 * no rule; it only classifies the pair it is handed, so both renderers stay
 * pure views of the report and the warm rule keeps its single home.
 *
 * It exists because the two renderers had the SAME three-branch logic written
 * out twice, which is exactly how they came to describe the wrong thing in
 * unison. The shared part is the four STATES; each renderer keeps its own
 * WORDING and markup (a CLI line is one greppable text token per field, a table
 * cell is markup), so no CLI formatting leaks into the HTML view or vice versa.
 */

/**
 * How a site's ENS name should read. FOUR states, because "absent" is two
 * different facts an operator must be able to tell apart:
 *
 *  - `stored`    — the site stores this name; it OVERRIDES any `.eth` id.
 *  - `inferred`  — the site stores NO name, but the box resolved this one from
 *    its `.eth` id, so this is the name it actually warms.
 *  - `opted-out` — the site stores `""`: never warm, even a `.eth` id. A
 *    CHOICE, so it must not read like a site that simply never set one.
 *  - `none`      — nothing stored and nothing resolved: no eth.limo name.
 */
export type EnsNameDisplay =
	/** A name the site STORES (an override of any `.eth` id). */
	| {kind: 'stored'; name: string}
	/** No stored name, but one INFERRED from the site's `.eth` id. */
	| {kind: 'inferred'; name: string}
	/** The stored `""` opt-out: never warmed. */
	| {kind: 'opted-out'}
	/** Nothing stored, nothing resolved. */
	| {kind: 'none'};

/** The two report fields the display state is read from. */
export interface EnsNameDisplayInput {
	/** The site's STORED `ensName`: a name, `""` (opt out), or absent. */
	ensName?: string;
	/** The ENS name the report already RESOLVED for warming, if any. */
	ensNameToWarm?: string;
}

/**
 * Classify a site's ENS name for display: which of the four
 * {@link EnsNameDisplay} states a renderer should show.
 *
 * A STATED `ensName` is total (a name is `stored`, `""` is `opted-out`) exactly
 * as it is for warming; only an ABSENT field consults the resolved name, which
 * is what separates "absent but inferred" from "absent and nothing".
 */
export function ensNameDisplay(site: EnsNameDisplayInput): EnsNameDisplay {
	if (site.ensName !== undefined) {
		return site.ensName === ''
			? {kind: 'opted-out'}
			: {kind: 'stored', name: site.ensName};
	}
	return site.ensNameToWarm === undefined
		? {kind: 'none'}
		: {kind: 'inferred', name: site.ensNameToWarm};
}
