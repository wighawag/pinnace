/**
 * A typed, per-node Kubo RPC client. It wraps `POST {baseUrl}/api/v0/<path>`
 * with an `Authorization: Bearer <token>` header on EVERY call. No Kubo binary
 * runs on the client — all interaction is HTTP.
 *
 * This is the seam every host-agnostic pinnace operation (deploy, publish,
 * status, site management) speaks. It is deliberately PER-NODE (one base URL +
 * one token); multi-target fan-out lives in the deploy task, not here.
 *
 * Behaviour ported (not copied) from the reference prototype
 * `~/searches/ipfs-hetzner/deploy-car.mjs`: the exact query params
 * (`files/mkdir?arg=/sites&parents=true`, `dag/import?pin-roots=true`, ...) and
 * the throw-on-`!ok` error handling.
 */

/** A minimal `fetch`-shaped function, so tests can inject a recording mock. */
export type FetchLike = (
	input: string | URL,
	init?: {method?: string; headers?: Record<string, string>; body?: unknown},
) => Promise<Response>;

/** Options for constructing a per-node {@link KuboRpcClient}. */
export interface KuboRpcClientOptions {
	/** The node's Kubo RPC base URL, e.g. `https://ipfs-api.example.com`. */
	baseUrl: string;
	/** The node's bearer token (sent on every call). */
	token: string;
	/** Injectable fetch (defaults to the global `fetch`); tests pass the mock. */
	fetchImpl?: FetchLike;
}

/**
 * A loud error carrying the endpoint + HTTP status of a non-2xx Kubo response,
 * so a caller (and a log) can see exactly which call failed and how.
 */
export class KuboRpcError extends Error {
	constructor(
		/** The `/api/v0/<endpoint>` path that failed. */
		readonly endpoint: string,
		/** The HTTP status returned. */
		readonly status: number,
		/** The response body text (for diagnostics). */
		readonly bodyText: string,
	) {
		super(`Kubo RPC ${endpoint} failed: ${status} ${bodyText}`);
		this.name = 'KuboRpcError';
	}
}

/** Flags accepted by `pin/add`. */
export interface PinAddOptions {
	/**
	 * Pin the whole DAG (`recursive=true`, the default and normal case) rather
	 * than the root block alone (`recursive=false`).
	 */
	recursive?: boolean;
}

/** Flags accepted by `files/mkdir`. */
export interface FilesMkdirOptions {
	/** Create parent directories as needed (`parents=true`). */
	parents?: boolean;
}

/** Flags accepted by `files/rm`. */
export interface FilesRmOptions {
	/** Remove directories recursively (`recursive=true`). */
	recursive?: boolean;
	/** Ignore nonexistent files (`force=true`). */
	force?: boolean;
}

/** Parameters for `name/publish`. */
export interface NamePublishOptions {
	/** The `/ipfs/<cid>` path to publish. */
	cidPath: string;
	/** The keystore key name to sign with. */
	key: string;
	/** Record lifetime (e.g. `72h`). */
	lifetime?: string;
	/** Record TTL (e.g. `1h`). */
	ttl?: string;
	/** Publish even with no online peers (`allow-offline=true`). */
	allowOffline?: boolean;
	/**
	 * An EXPLICIT record sequence number, for the one case Kubo cannot get right
	 * on its own: a NEW signer taking over a name that is already live.
	 *
	 * Kubo picks the sequence by looking for the name's existing record, first in
	 * its local datastore and then (only then) in the routing system. On a node
	 * that has never signed this name the local lookup misses, and if the routing
	 * lookup ALSO fails — not-found, a network error, or its 30s timeout — boxo
	 * cannot tell that apart from a genuinely new name and SILENTLY starts at
	 * sequence 0. Higher sequence wins in IPNS, so that record loses to the old
	 * publisher's for the remainder of its ~72h validity while every indicator
	 * reads green. See
	 * `work/notes/findings/ipns-sequence-resets-to-zero-on-a-new-signer.md`.
	 *
	 * Kubo REFUSES a sequence that is not strictly higher than the existing
	 * record's (and refuses 0 outright when there is no existing record), so this
	 * is a safe upper bound rather than a footgun: it either applies or errors,
	 * and can never silently regress a name.
	 */
	sequence?: number;
}

/**
 * The subset of Kubo's `name/inspect` result pinnace reads: the decoded IPNS
 * record `Entry`. Every field is optional because the endpoint is marked
 * EXPERIMENTAL in Kubo and its shape is not ours to guarantee — the caller
 * treats a missing `Sequence` as "could not read", never as 0.
 */
export interface NameInspectResult {
	Entry?: {
		/** The `/ipfs/<cid>` path the record points at. */
		Value?: string;
		/** The record's sequence number. Higher wins among unexpired records. */
		Sequence?: number;
		/** The record's expiry (RFC3339). */
		Validity?: string;
	};
}

export class KuboRpcClient {
	/**
	 * The node this client speaks to (normalised: no trailing slash). PUBLIC so
	 * an error raised ABOUT a node can name WHICH node it was — a per-node client
	 * is otherwise anonymous, and "the metadata read failed" is useless to an
	 * operator running a fan-out. Read-only: the target is fixed at construction.
	 */
	readonly baseUrl: string;
	private readonly token: string;
	private readonly fetchImpl: FetchLike;

	constructor(options: KuboRpcClientOptions) {
		// Normalise: strip trailing slashes so path joining is unambiguous.
		this.baseUrl = options.baseUrl.replace(/\/+$/, '');
		this.token = options.token;
		this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
	}

	/**
	 * The core request primitive: POST `/api/v0/<endpoint>?<query>` with the
	 * bearer token. Throws {@link KuboRpcError} on any non-2xx. Returns the raw
	 * {@link Response} so callers can decode JSON or bytes as they need.
	 */
	async request(
		endpoint: string,
		query?: URLSearchParams,
		body?: unknown,
		extraHeaders?: Record<string, string>,
	): Promise<Response> {
		const qs =
			query && [...query.keys()].length > 0 ? `?${query.toString()}` : '';
		const url = `${this.baseUrl}/api/v0/${endpoint}${qs}`;
		const res = await this.fetchImpl(url, {
			method: 'POST',
			headers: {authorization: `Bearer ${this.token}`, ...(extraHeaders ?? {})},
			body,
		});
		if (!res.ok) {
			const text = await safeText(res);
			throw new KuboRpcError(endpoint, res.status, text);
		}
		return res;
	}

	/** POST an endpoint and parse the JSON response body. */
	private async requestJson<T = unknown>(
		endpoint: string,
		query?: URLSearchParams,
		body?: unknown,
		extraHeaders?: Record<string, string>,
	): Promise<T> {
		const res = await this.request(endpoint, query, body, extraHeaders);
		return (await res.json()) as T;
	}

	/** `id` — the node's identity (PeerID etc.). */
	id<T = unknown>(): Promise<T> {
		return this.requestJson<T>('id');
	}

	/**
	 * `add` — add raw bytes (returned shape is Kubo-defined). Kubo requires the
	 * payload as a `multipart/form-data` `file` part, NOT a raw body, so we send
	 * a {@link FormData} and let `fetch` set the multipart boundary itself (see
	 * {@link fileUpload}).
	 */
	add<T = unknown>(data: Uint8Array): Promise<T> {
		return this.fileUpload<T>('add', undefined, data);
	}

	/** `dag/import?pin-roots=true` — import a CAR and pin its roots. */
	dagImport<T = unknown>(car: Uint8Array): Promise<T> {
		const q = new URLSearchParams({'pin-roots': 'true'});
		return this.fileUpload<T>('dag/import', q, car);
	}

	/**
	 * `pin/rm?arg=<cid>` — UNPIN content so Kubo can garbage-collect it and
	 * reclaim storage. The counterpart to `dag/import?pin-roots=true`: removing a
	 * site unpins its CID here so it stops being served/announced. `arg` takes a
	 * bare CID (or an `/ipfs/<cid>` path); callers pass the CID from `files/stat`.
	 */
	pinRm<T = unknown>(cid: string): Promise<T> {
		return this.requestJson<T>('pin/rm', new URLSearchParams({arg: cid}));
	}

	/**
	 * `pin/add?arg=<cid>&recursive=true` — PIN an arbitrary CID, FETCHING it over
	 * the network first if the node does not already hold the blocks. This is what
	 * lets the operator's nodes pin external content they only have the CID for
	 * (the `pin` verb), as opposed to `dag/import` which uploads local bytes.
	 *
	 * BLOCKING: Kubo resolves + fetches the whole DAG before responding, so this
	 * call can take a long time for a large DAG, and if NOTHING on the network
	 * serves the content it does not return until Kubo gives up (IPFS physics, not
	 * a pinnace gap). Callers that need a bound must impose it themselves — this
	 * client sets no timeout, because a default one would abort legitimately slow
	 * large-DAG pins.
	 *
	 * `arg` takes a bare CID (or an `/ipfs/<cid>` path). `recursive` is sent
	 * EXPLICITLY (rather than relying on Kubo's default) so the request shape
	 * always states the intent.
	 */
	pinAdd<T = unknown>(cid: string, options: PinAddOptions = {}): Promise<T> {
		const recursive = options.recursive ?? true;
		const q = new URLSearchParams({arg: cid, recursive: String(recursive)});
		return this.requestJson<T>('pin/add', q);
	}

	/** `files/mkdir?arg=<path>[&parents=true]`. */
	async filesMkdir(
		path: string,
		options: FilesMkdirOptions = {},
	): Promise<void> {
		const q = new URLSearchParams({arg: path});
		if (options.parents) q.set('parents', 'true');
		await this.request('files/mkdir', q);
	}

	/** `files/rm?arg=<path>[&recursive=true][&force=true]`. */
	async filesRm(path: string, options: FilesRmOptions = {}): Promise<void> {
		const q = new URLSearchParams({arg: path});
		if (options.recursive) q.set('recursive', 'true');
		if (options.force) q.set('force', 'true');
		await this.request('files/rm', q);
	}

	/** `files/cp?arg=<from>&arg=<to>`. */
	async filesCp(from: string, to: string): Promise<void> {
		const q = new URLSearchParams();
		q.append('arg', from);
		q.append('arg', to);
		await this.request('files/cp', q);
	}

	/** `files/stat?arg=<path>` — returns the MFS entry stat (Hash, Type, ...). */
	filesStat<T = unknown>(path: string): Promise<T> {
		return this.requestJson<T>('files/stat', new URLSearchParams({arg: path}));
	}

	/**
	 * `files/write?arg=<path>&create=true&parents=true&truncate=true` — CREATE OR
	 * FULLY REPLACE an MFS file with `bytes`. This is the channel a site's
	 * `metadata.json` travels on (`/sites/<id>/metadata.json`).
	 *
	 * The three flags are sent UNCONDITIONALLY (no options bag) because they are
	 * what makes the call mean "this path now holds exactly these bytes":
	 * `create` writes a file that does not exist yet, `parents` makes its wrapper
	 * directory, and `truncate` zeroes the file first, so a re-write REPLACES the
	 * old content instead of appending into it (Kubo's `files/write` is an
	 * APPEND/offset-write by default — without `truncate`, re-writing shorter
	 * metadata would leave a tail of the previous JSON behind and produce corrupt
	 * bytes). Offset/partial writes are deliberately not exposed: nothing in
	 * pinnace writes part of an MFS file.
	 *
	 * Like Kubo's other file-upload endpoints, the payload MUST be a
	 * `multipart/form-data` `file` part, not a raw body (see {@link fileUpload}).
	 * The response body is empty, so it is not parsed as JSON.
	 */
	async filesWrite(path: string, bytes: Uint8Array): Promise<void> {
		const q = new URLSearchParams({
			arg: path,
			create: 'true',
			parents: 'true',
			truncate: 'true',
		});
		await this.fileUploadRequest('files/write', q, bytes);
	}

	/**
	 * `files/read?arg=<path>` — read an MFS file's bytes (the counterpart to
	 * {@link filesWrite}). A body-less read: nothing is uploaded.
	 *
	 * A path that does not exist is a non-2xx from Kubo, so it raises the loud
	 * {@link KuboRpcError} naming the endpoint + status like every other call —
	 * absence is never a silent empty buffer. A caller that treats "no such file"
	 * as "no metadata yet" catches that error deliberately.
	 */
	async filesRead(path: string): Promise<Uint8Array> {
		const res = await this.request(
			'files/read',
			new URLSearchParams({arg: path}),
		);
		return new Uint8Array(await res.arrayBuffer());
	}

	/** `files/ls?arg=<path>[&l=true]` — list an MFS directory. */
	filesLs<T = unknown>(path: string, long = true): Promise<T> {
		const q = new URLSearchParams({arg: path});
		if (long) q.set('long', 'true');
		return this.requestJson<T>('files/ls', q);
	}

	/** `key/list?l=true` — list keystore keys with their IPNS ids. */
	keyList<T = unknown>(): Promise<T> {
		return this.requestJson<T>('key/list', new URLSearchParams({l: 'true'}));
	}

	/** `key/gen?arg=<name>&type=ed25519` — generate a new keystore key. */
	keyGen<T = unknown>(name: string): Promise<T> {
		const q = new URLSearchParams({arg: name, type: 'ed25519'});
		return this.requestJson<T>('key/gen', q);
	}

	/**
	 * `key/import?arg=<name>` — import key MATERIAL (libp2p/protobuf bytes) into
	 * the keystore. The node, not the client, signs records with it.
	 */
	keyImport<T = unknown>(name: string, keyBytes: Uint8Array): Promise<T> {
		const q = new URLSearchParams({arg: name});
		return this.fileUpload<T>('key/import', q, keyBytes);
	}

	/**
	 * Kubo's file-upload endpoints require the payload as a `multipart/form-data`
	 * body with the bytes as a named file part (confirmed by the Kubo RPC docs'
	 * `-F <field>=@…` cURL examples and a live daemon). A raw
	 * `application/octet-stream` body is rejected with
	 * `400 file argument '<field>' is required`.
	 *
	 * The field name is endpoint-specific: `add`, `dag/import` and `key/import`
	 * expect `file` (the default), while `routing/put` expects `value-file`.
	 *
	 * We build a {@link FormData} and pass it as the body WITHOUT a hand-set
	 * `content-type`: `fetch` serialises the FormData and sets
	 * `content-type: multipart/form-data; boundary=…` itself. Setting it manually
	 * would omit/override the boundary and break the request.
	 */
	private async fileUpload<T = unknown>(
		endpoint: string,
		query: URLSearchParams | undefined,
		bytes: Uint8Array,
		field = 'file',
	): Promise<T> {
		const res = await this.fileUploadRequest(endpoint, query, bytes, field);
		return (await res.json()) as T;
	}

	/**
	 * {@link fileUpload} without the JSON decode, for the upload endpoints whose
	 * successful response carries NO body (`files/write`), where parsing would
	 * throw on the empty body.
	 */
	private fileUploadRequest(
		endpoint: string,
		query: URLSearchParams | undefined,
		bytes: Uint8Array,
		field = 'file',
	): Promise<Response> {
		const form = new FormData();
		form.append(field, new Blob([bytes as BlobPart]), field);
		return this.request(endpoint, query, form);
	}

	/** `name/publish?arg=<cidPath>&key=<key>&lifetime=..&ttl=..` — sign+publish IPNS. */
	namePublish<T = unknown>(options: NamePublishOptions): Promise<T> {
		const q = new URLSearchParams({arg: options.cidPath, key: options.key});
		if (options.lifetime) q.set('lifetime', options.lifetime);
		if (options.ttl) q.set('ttl', options.ttl);
		if (options.allowOffline) q.set('allow-offline', 'true');
		// Sent only when STATED: omitting it leaves Kubo's own sequence logic
		// untouched (continue from the existing record, ++ only if the value
		// changed), which is right for every publish by a node that already signs
		// this name. `0` is NOT a meaningful override (Kubo rejects it outright), so
		// it is not sent either.
		if (options.sequence) q.set('sequence', String(options.sequence));
		return this.requestJson<T>('name/publish', q);
	}

	/**
	 * `name/inspect` — decode a raw signed IPNS record into its fields (notably
	 * the SEQUENCE number). Takes the record as a `multipart/form-data` `file`
	 * part, exactly like the other upload endpoints (Kubo declares it as a
	 * `FileArg`), so it goes through {@link fileUpload} rather than a raw body.
	 *
	 * `dump=false` suppresses the full hex dump of the protobuf, which Kubo
	 * includes BY DEFAULT and which pinnace never reads — a status pass over
	 * every site would otherwise haul a hex blob per site for nothing.
	 *
	 * Pairs with {@link routingGet}: fetch the raw record, then inspect it. Kubo
	 * marks this endpoint EXPERIMENTAL, so callers must treat an unexpected shape
	 * as "could not read", never as a value.
	 */
	nameInspect<T = NameInspectResult>(record: Uint8Array): Promise<T> {
		return this.fileUpload<T>(
			'name/inspect',
			new URLSearchParams({dump: 'false'}),
			record,
		);
	}

	/**
	 * `name/resolve?arg=/ipns/<name>&recursive=true`: resolve an IPNS NAME to the
	 * `/ipfs/<cid>` it CURRENTLY points at, and return that cid. This is the read
	 * the `pin --from-ipns <source>` MIGRATE path stands on: the SOURCE name
	 * (someone else's, or the operator's old one) turned into the snapshot cid the
	 * existing pin flow then pins. It is a plain read: nothing is signed, and the
	 * operator's OWN name (the `--as <name>` derived key) is untouched.
	 *
	 * `name` is normalised, so all three forms an operator has in hand work: a
	 * bare id (`k51...`), an `/ipns/<id>` path, and the `ipns://<id>` address
	 * pinnace itself prints (and ENS contenthashes carry). A DNSLink name
	 * (`example.com`) normalises the same way and is Kubo's business to resolve.
	 *
	 * BLOCKING, like {@link pinAdd}: Kubo does the DHT/DNSLink work and answers
	 * when it has an answer or gives up. No timeout is imposed here (Kubo's own
	 * resolve behaviour is the bound). `recursive=true` is sent EXPLICITLY (as
	 * {@link pinAdd} sends `recursive`) so the request shape states the intent:
	 * follow a chain of names to the content it ends at.
	 *
	 * @returns the resolved content path WITHOUT the `/ipfs/` prefix: normally a
	 * bare cid, and `<cid>/<subpath>` for the unusual name that points INTO a
	 * directory, which every downstream call (`pin/add`, `files/cp`,
	 * `name/publish`) accepts verbatim, so the pinned content is exactly what the
	 * name said rather than a silently widened parent.
	 * @throws {KuboRpcError} on any non-2xx, carrying Kubo's own message (e.g. `routing:
	 * not found` for a name that never resolved or whose record expired).
	 * @throws if a 2xx body carries no `/ipfs/...` path (never a silent empty cid).
	 */
	async nameResolve(name: string): Promise<string> {
		const ipnsPath = ipnsPathFor(name);
		const q = new URLSearchParams({arg: ipnsPath, recursive: 'true'});
		const body = await this.requestJson<{Path?: string}>('name/resolve', q);
		const path = body?.Path ?? '';
		const cid = path.startsWith(IPFS_PATH_PREFIX)
			? path.slice(IPFS_PATH_PREFIX.length)
			: '';
		if (!cid) {
			throw new Error(
				`Kubo RPC name/resolve ${ipnsPath} returned no ${IPFS_PATH_PREFIX}<cid> ` +
					`path (got ${JSON.stringify(body?.Path ?? body)}): that name does ` +
					`not currently point at content`,
			);
		}
		return cid;
	}

	/**
	 * `routing/get?arg=<ipnsPath>`: fetch the raw signed record for a name.
	 *
	 * UNLIKE the `ipfs routing get > file` shell pipeline, the HTTP RPC does NOT
	 * return raw record bytes. It returns a JSON `QueryEvent` with the record
	 * BASE64-ENCODED in `Extra`; the raw-bytes writer lives only in the command's
	 * `cmds.Text` encoder, which the CLI selects and HTTP does not. So the decode
	 * belongs HERE, once, rather than in each caller. See
	 * `work/notes/findings/kubo-routing-get-returns-a-json-envelope-not-the-record.md`.
	 *
	 * This is asymmetric with {@link routingPut}, which takes RAW bytes and
	 * VALIDATES them, so a naive get -> put round trip re-announces the envelope
	 * instead of the record and is rejected as a malformed record.
	 *
	 * The envelope is a 200-OK non-empty text body, so nothing upstream fails on
	 * it: a missing or non-string `Extra` is therefore a LOUD error naming the
	 * node, never a silent empty record that would later read as "no record".
	 */
	async routingGet(ipnsPath: string): Promise<Uint8Array> {
		const res = await this.request(
			'routing/get',
			new URLSearchParams({arg: ipnsPath}),
		);
		const body = await res.text();
		let extra: unknown;
		try {
			extra = (JSON.parse(body) as {Extra?: unknown}).Extra;
		} catch {
			throw new Error(
				`Kubo RPC routing/get ${ipnsPath} on ${this.baseUrl}: expected a JSON ` +
					`QueryEvent carrying the record in base64 'Extra', got a body that is ` +
					`not JSON (${body.slice(0, 80)})`,
			);
		}
		if (typeof extra !== 'string' || extra === '')
			throw new Error(
				`Kubo RPC routing/get ${ipnsPath} on ${this.baseUrl}: JSON QueryEvent ` +
					`carries no base64 'Extra', so there is no record to decode`,
			);
		return new Uint8Array(Buffer.from(extra, 'base64'));
	}

	/**
	 * `routing/put?arg=<ipnsPath>` — (re-)announce a signed record body. Kubo's
	 * `routing/put` takes the record as a `multipart/form-data` file part named
	 * **`value-file`** (NOT the generic `file` the other upload endpoints use); a
	 * raw `application/octet-stream` body is rejected with
	 * `400 file argument 'value-file' is required`. Goes through {@link fileUpload}
	 * so `fetch` owns the multipart boundary (no hand-set content-type).
	 */
	async routingPut(ipnsPath: string, record: Uint8Array): Promise<void> {
		const q = new URLSearchParams({arg: ipnsPath});
		await this.fileUpload('routing/put', q, record, 'value-file');
	}
}

/** The prefix a resolved IPNS name's content path carries. */
const IPFS_PATH_PREFIX = '/ipfs/';

/**
 * Normalise the three forms an IPNS name reaches us in into the single
 * `/ipns/<id>` path `name/resolve` takes: a bare id (`k51...`), an `/ipns/<id>`
 * path, and the `ipns://<id>` address pinnace prints and ENS contenthashes
 * carry.
 */
function ipnsPathFor(name: string): string {
	const id = name
		.trim()
		.replace(/^ipns:\/\//, '')
		.replace(/^\/ipns\//, '')
		.replace(/^\/+/, '');
	if (!id) {
		throw new Error('nameResolve requires an IPNS name to resolve');
	}
	return `/ipns/${id}`;
}

/** Read a response body as text without throwing (best-effort for errors). */
async function safeText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return '';
	}
}
