/**
 * The THREE-VALUED outcome of an external check — the repo convention
 * (`CONTEXT.md` `## Conventions`) made into a type: **a check that could not RUN
 * never reports a definitive negative**.
 *
 * `status` reaches outside the node three times (the delegated-routing
 * providers lookup, the cold CID-gateway probe, the eth.limo probe). Each can
 * end in three ways, and the middle one is the one this module exists to keep
 * separate:
 *
 *  - `yes`     — we asked, and the answer is yes,
 *  - `no`      — we asked, and the answer is NO (a real, reportable negative),
 *  - `unknown` — we could NOT ask (rate-limited, unreachable, unparsable, or we
 *    could not even identify what to ask about), WITH the reason.
 *
 * The defect this replaces was live: a box reported `announced=false` for a
 * site the delegated router WAS listing at that moment. The lookup had failed
 * (`if (!res.ok) return {Providers: []}` — a 429 read as an empty provider
 * list), and a failed lookup was indistinguishable from a real negative. It was
 * the FIFTH instance of that class in this codebase, hence a shared vocabulary
 * rather than a fifth local fix.
 *
 * It is a pure LEAF: no imports, no clock, no network. That matters because
 * every layer needs it — the `status` core ({@link ../status/status-report.js}),
 * the on-box command surface ({@link ../node/node-commands.js}), the dashboard
 * renderer ({@link ./status-html.js}) and the CLI `status` line — and
 * `status-html` must stay free of core imports (`node-commands` imports it).
 *
 * Rendering CONVENTION, shared by every consumer: `yes`/`no` keep the tokens
 * they already had (`true`/`false` on the CLI line, `ok`/`no` on the
 * dashboard), and `unknown` is NEUTRAL — never the negative indicator — and
 * carries its reason so the operator can act on it (`http 429` reads as "try
 * again", `no` reads as "your site is not announced").
 */

/**
 * What an external check ANSWERED. Three states, of which the third is the
 * point: it is not a soft `no`, it is the absence of an answer.
 */
export type CheckOutcome =
	/** We asked, and the answer is yes. */
	| {state: 'yes'}
	/** We asked, and the answer is no — a real, reportable negative. */
	| {state: 'no'}
	/** We could NOT ask; `reason` says why (an HTTP status, a short error kind). */
	| {state: 'unknown'; reason: string};

/** The three states, for renderers that switch on them. */
export type CheckState = CheckOutcome['state'];

/**
 * The SAME convention where the positive answer is a VALUE rather than a yes:
 * an IPNS record's SEQUENCE number, which decides which record wins (highest
 * unexpired sequence).
 *
 * It cannot be a {@link CheckOutcome} because `yes` carries nothing, and it is
 * NOT modelled as `number | undefined` because the failure this exists to expose
 * is a spurious 0: a node that cannot see a live record silently signs sequence
 * 0 and loses (see
 * `work/notes/findings/ipns-sequence-resets-to-zero-on-a-new-signer.md`). A
 * reader that defaulted "could not read" to 0 would reproduce that exact bug in
 * the reporting layer, so "we could not read it" is its own state, with a reason,
 * exactly as `unknown` is for a yes/no check.
 *
 * It lives HERE, in the pure leaf, for the same reason {@link CheckOutcome}
 * does: the reader is publisher machinery but the renderers (`status-html`, the
 * CLI line) must not import core to display it.
 */
export type RecordSequence =
	/** We read the record and this is its sequence. */
	| {state: 'known'; sequence: number}
	/** We could NOT read it; `reason` says why. */
	| {state: 'unknown'; reason: string};

/** The canonical "could not read the sequence" outcome (reason normalised). */
export function sequenceUnknown(reason: string): RecordSequence {
	return {state: 'unknown', reason: shortReason(reason)};
}

/**
 * How a {@link RecordSequence} PRINTS on a status line or in a dashboard cell:
 * the number when known, else `unknown (<reason>)`. Shared so the CLI and the
 * dashboard cannot drift, and so neither invents a number for an unknown.
 */
export function printedSequence(sequence: RecordSequence | undefined): string {
	if (sequence === undefined) return 'n/a';
	return sequence.state === 'known'
		? String(sequence.sequence)
		: `unknown (${sequence.reason})`;
}

/** The canonical `yes` outcome (checks that ran and answered yes). */
export const CHECK_YES: CheckOutcome = Object.freeze({state: 'yes'});

/** The canonical `no` outcome — a check that RAN and answered no. */
export const CHECK_NO: CheckOutcome = Object.freeze({state: 'no'});

/** The reason used when a failure gave us nothing more specific to say. */
export const UNKNOWN_CHECK_REASON = 'could not check';

/** How long a reason may be before it is truncated (a status LINE must stay readable). */
const MAX_REASON_LENGTH = 120;

/**
 * The outcome of a check that RAN: its definite yes/no answer. Use this ONLY
 * where the check actually produced an answer — an error path must go through
 * {@link checkUnknown}, never through `checkAnswer(false)`.
 */
export function checkAnswer(yes: boolean): CheckOutcome {
	return yes ? CHECK_YES : CHECK_NO;
}

/**
 * The outcome of a check that could NOT run, carrying WHY (`http 429`,
 * `fetch failed`, `no peer id`, ...). The reason is normalised to one short
 * line, and is never empty: an unknown with nothing to say is still an unknown,
 * so it falls back to {@link UNKNOWN_CHECK_REASON}.
 */
export function checkUnknown(reason: string): CheckOutcome {
	return {state: 'unknown', reason: shortReason(reason)};
}

/**
 * Is this outcome a definite YES? The predicate a roll-up must use: an
 * `unknown` is NOT a yes (nothing is verified) and NOT a failure either — it
 * simply does not count as verified. An ABSENT outcome (a report that did not
 * run the check) is not a yes either.
 */
export function isYes(outcome: CheckOutcome | undefined): boolean {
	return outcome?.state === 'yes';
}

/**
 * The state a RENDERER should show, reading an ABSENT outcome as `unknown`:
 * a report that carries no verdict did not run that check, and painting it as
 * a negative is the very lie the three states remove.
 *
 * (This is NOT the same as the eth.limo column's absent-means-NOT-APPLICABLE:
 * there, "nothing to probe" is signalled by the site resolving no ENS name at
 * all, and the renderer never reaches for a verdict.)
 */
export function checkState(outcome: CheckOutcome | undefined): CheckState {
	return outcome?.state ?? 'unknown';
}

/**
 * A check could not be MADE. Thrown by the live checks (e.g. a non-2xx from the
 * delegated-routing endpoint) so the reason survives the throw instead of being
 * flattened into an empty result — the exact flattening that produced the false
 * `announced=false` on a live box.
 */
export class CheckUnavailableError extends Error {
	/** The short reason the check could not run (also this error's `message`). */
	readonly reason: string;

	constructor(reason: string, options?: {cause?: unknown}) {
		const short = shortReason(reason);
		super(short, options);
		this.name = 'CheckUnavailableError';
		this.reason = short;
	}
}

/**
 * The reason to record for a thrown failure: a {@link CheckUnavailableError}'s
 * own reason, else the error's message, normalised to one short line, else
 * {@link UNKNOWN_CHECK_REASON}. Never empty, never multi-line, never the whole
 * stack — it is printed on a CLI line and in a dashboard cell.
 */
export function unavailableReason(error: unknown): string {
	if (error instanceof CheckUnavailableError) return error.reason;
	if (error instanceof Error) return shortReason(error.message);
	return UNKNOWN_CHECK_REASON;
}

/**
 * Collapse whitespace, trim, truncate; empty becomes {@link UNKNOWN_CHECK_REASON}.
 * EXPORTED because it is the repo's ONE definition of "a reason fit for a status
 * line": the eth.limo resolution axes ({@link ./ethlimo-resolution.js}) carry
 * their own `unknown` reasons outside a {@link CheckOutcome}, and a second
 * normaliser would drift from this one.
 */
export function shortReason(reason: string): string {
	const collapsed = reason.replaceAll(/\s+/g, ' ').trim();
	if (collapsed === '') return UNKNOWN_CHECK_REASON;
	return collapsed.length > MAX_REASON_LENGTH
		? `${collapsed.slice(0, MAX_REASON_LENGTH - 3)}...`
		: collapsed;
}
