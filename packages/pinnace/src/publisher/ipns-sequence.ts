/**
 * Reading an IPNS name's CURRENT record SEQUENCE number from a node, so the
 * operator can SEE the one number that decides which record wins.
 *
 * WHY THIS EXISTS. Among unexpired IPNS records, the HIGHEST sequence wins.
 * That makes the sequence the deciding fact in exactly the two situations
 * pinnace's publisher/replica model is built around, and in both of them
 * pinnace was previously blind:
 *
 *  - **A new signer taking over a live name** (the failover case). A node that
 *    has never signed this name asks Kubo to publish; Kubo looks for the
 *    existing record locally, then in the routing system, and if BOTH miss it
 *    silently starts at sequence 0. A sequence-0 record loses to the old
 *    publisher's sequence-N record for the remainder of its ~72h validity,
 *    while the new publisher signs happily, exports a record, replicas mirror
 *    it, and every pinnace indicator reads green. See
 *    `work/notes/findings/ipns-sequence-resets-to-zero-on-a-new-signer.md`.
 *  - **Two signers racing one name** (the split-brain `authorize` refuses to
 *    walk into, and which best-effort key removal cannot close). Two nodes
 *    signing one name climb each other's sequence numbers and the name flaps.
 *    Divergent sequences across a fleet are the observable symptom.
 *
 * `status` reports this per site per node, so both show up as a number an
 * operator can compare across boxes rather than as a name that mysteriously
 * points at the wrong CID.
 *
 * THE READ IS TWO CALLS, both already part of pinnace's Kubo surface:
 * `routing/get` for the raw signed record (the same call the publisher's
 * `republish` uses to EXPORT it), then `name/inspect` to decode it. pinnace
 * decodes no protobuf itself.
 *
 * NOT here: deciding what to DO about a sequence. This module only reports.
 * The corrective lever is `NamePublishOptions.sequence` on the RPC client, and
 * pulling it is an operator decision (see the failover runbook), never an
 * automatic behaviour: silently bumping a sequence is how you paper over a
 * split-brain instead of noticing it.
 */
import type {KuboRpcClient, NameInspectResult} from '../rpc/kubo-rpc-client.js';
import {
	sequenceUnknown,
	UNKNOWN_CHECK_REASON,
	type RecordSequence,
} from '../status/check-outcome.js';

/**
 * The outcome type lives in the pure `check-outcome` leaf (where the repo's
 * "a check that could not run reports no definite answer" vocabulary lives), so
 * that the RENDERERS can display it without importing this module. Re-exported
 * here because this is where the value is PRODUCED.
 */
export type {RecordSequence};

/**
 * Read the current sequence of `ipnsId`'s record as THIS node sees it.
 *
 * FAIL-SOFT BY CONSTRUCTION: every failure path (the routing lookup missing or
 * erroring, an empty record body, `name/inspect` throwing, and an inspect result
 * whose `Entry.Sequence` is absent or not a finite number) returns an `unknown`
 * carrying its reason. It NEVER throws and NEVER invents a number, because it is
 * called from `status`, where a wrong number is worse than no number: the
 * operator would be comparing sequences across boxes to decide whether a
 * failover took.
 *
 * The number is what this NODE currently holds/sees, not a fleet-wide truth.
 * Comparing it ACROSS nodes is the point; a single node's answer proves nothing
 * about who is winning in the DHT.
 */
export async function readRecordSequence(
	client: KuboRpcClient,
	ipnsId: string,
): Promise<RecordSequence> {
	let record: Uint8Array;
	try {
		record = await client.routingGet(`/ipns/${ipnsId}`);
	} catch (error) {
		return sequenceUnknown(reasonOf(error, 'routing/get failed'));
	}
	// A present-but-empty body is not a record. Decoding it would either throw
	// downstream or, worse, decode to something with no Entry that a laxer reader
	// might read as 0.
	if (record.length === 0) return sequenceUnknown('empty record');

	let inspected: NameInspectResult;
	try {
		inspected = await client.nameInspect<NameInspectResult>(record);
	} catch (error) {
		return sequenceUnknown(reasonOf(error, 'name/inspect failed'));
	}

	const sequence = inspected?.Entry?.Sequence;
	// `name/inspect` is EXPERIMENTAL in Kubo, so its shape is not ours to rely
	// on: anything that is not a finite number reads as unknown, including the
	// `undefined` a changed response shape would produce.
	if (typeof sequence !== 'number' || !Number.isFinite(sequence))
		return sequenceUnknown('no sequence in record');
	return {state: 'known', sequence};
}

/** An error's short reason, falling back to a caller-supplied description. */
function reasonOf(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message) return error.message;
	return fallback || UNKNOWN_CHECK_REASON;
}
