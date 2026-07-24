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
}

export class KuboRpcClient {
	private readonly baseUrl: string;
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

	/** `add` — add raw bytes (returned shape is Kubo-defined). */
	add<T = unknown>(data: Uint8Array): Promise<T> {
		return this.requestJson<T>('add', undefined, new Blob([data as BlobPart]), {
			'content-type': 'application/octet-stream',
		});
	}

	/** `dag/import?pin-roots=true` — import a CAR and pin its roots. */
	dagImport<T = unknown>(car: Uint8Array): Promise<T> {
		const q = new URLSearchParams({'pin-roots': 'true'});
		return this.requestJson<T>('dag/import', q, new Blob([car as BlobPart]), {
			'content-type': 'application/octet-stream',
		});
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
		return this.requestJson<T>(
			'key/import',
			q,
			new Blob([keyBytes as BlobPart]),
			{
				'content-type': 'application/octet-stream',
			},
		);
	}

	/** `name/publish?arg=<cidPath>&key=<key>&lifetime=..&ttl=..` — sign+publish IPNS. */
	namePublish<T = unknown>(options: NamePublishOptions): Promise<T> {
		const q = new URLSearchParams({arg: options.cidPath, key: options.key});
		if (options.lifetime) q.set('lifetime', options.lifetime);
		if (options.ttl) q.set('ttl', options.ttl);
		if (options.allowOffline) q.set('allow-offline', 'true');
		return this.requestJson<T>('name/publish', q);
	}

	/** `routing/get?arg=<ipnsPath>` — fetch the raw signed record for a name. */
	async routingGet(ipnsPath: string): Promise<Uint8Array> {
		const res = await this.request(
			'routing/get',
			new URLSearchParams({arg: ipnsPath}),
		);
		return new Uint8Array(await res.arrayBuffer());
	}

	/** `routing/put?arg=<ipnsPath>` — (re-)announce a signed record body. */
	async routingPut(ipnsPath: string, record: Uint8Array): Promise<void> {
		const q = new URLSearchParams({arg: ipnsPath});
		await this.request('routing/put', q, new Blob([record as BlobPart]), {
			'content-type': 'application/octet-stream',
		});
	}
}

/** Read a response body as text without throwing (best-effort for errors). */
async function safeText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return '';
	}
}
