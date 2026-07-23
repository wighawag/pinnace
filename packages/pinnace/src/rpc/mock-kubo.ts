/**
 * A mock Kubo HTTP API for tests: it RECORDS every incoming request (method,
 * path, query, headers, body) and returns canned responses, so a test can
 * assert the exact call shape a `KuboRpcClient` produced WITHOUT a live daemon.
 *
 * This is the primary test boundary for every host-agnostic pinnace operation
 * (deploy, publish, status, site management). It is exposed from the package's
 * test surface so sibling tasks (deploy-multi-target, status-report, ...) reuse
 * it rather than re-inventing a Kubo fake.
 */

/** One recorded RPC request as the mock observed it. */
export interface RecordedRequest {
	/** The HTTP method (Kubo RPC is always POST). */
	method: string;
	/** The `/api/v0/...` path, WITHOUT the base URL or query string. */
	path: string;
	/** Parsed query parameters (multi-valued: `arg` can repeat). */
	query: URLSearchParams;
	/** Lower-cased header name → value, as fetch delivered them. */
	headers: Record<string, string>;
	/** The raw request body as text (empty string if none). */
	bodyText: string;
	/** The full URL that was fetched. */
	url: string;
}

/** A canned response for a given `/api/v0/<path>` (path without query). */
export interface MockResponseSpec {
	/** HTTP status to return (default 200). */
	status?: number;
	/** JSON body to return; serialised and sent with content-type application/json. */
	json?: unknown;
	/** Raw text body to return (takes precedence over `json` if both set). */
	text?: string;
}

/**
 * A recording mock Kubo API. Install it with {@link fetchImpl} as the `fetch`
 * a {@link KuboRpcClient} uses; inspect {@link requests} afterwards.
 */
export class MockKuboApi {
	/** Every request the mock received, in order. */
	readonly requests: RecordedRequest[] = [];

	/** path (no query) → canned response. */
	private readonly responses = new Map<string, MockResponseSpec>();

	/** The base URL this mock pretends to be (only its path/query are used). */
	constructor(readonly baseUrl: string = 'https://node.example.test') {}

	/** Register a canned response for a Kubo `/api/v0/<path>` (path without query). */
	on(path: string, spec: MockResponseSpec): this {
		this.responses.set(path, spec);
		return this;
	}

	/** The most recent recorded request, or undefined if none. */
	get lastRequest(): RecordedRequest | undefined {
		return this.requests[this.requests.length - 1];
	}

	/** All recorded requests whose path equals `path`. */
	requestsFor(path: string): RecordedRequest[] {
		return this.requests.filter((r) => r.path === path);
	}

	/**
	 * A `fetch`-compatible function that records the request and returns the
	 * canned (or a default empty-JSON 200) response. Pass this to the client.
	 */
	readonly fetchImpl = async (
		input: string | URL,
		init?: {method?: string; headers?: Record<string, string>; body?: unknown},
	): Promise<Response> => {
		const url = new URL(typeof input === 'string' ? input : input.toString());
		const path = url.pathname.replace(/^\/api\/v0\//, '');
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(init?.headers ?? {})) {
			headers[k.toLowerCase()] = v;
		}
		const bodyText = await bodyToText(init?.body);
		this.requests.push({
			method: init?.method ?? 'GET',
			path,
			query: new URLSearchParams(url.search),
			headers,
			bodyText,
			url: url.toString(),
		});

		const spec = this.responses.get(path);
		const status = spec?.status ?? 200;
		if (spec?.text !== undefined) {
			return new Response(spec.text, {status});
		}
		const payload = spec?.json ?? {};
		return new Response(JSON.stringify(payload), {
			status,
			headers: {'content-type': 'application/json'},
		});
	};
}

/** Best-effort stringify of a fetch body for recording/assertions. */
async function bodyToText(body: unknown): Promise<string> {
	if (body === undefined || body === null) return '';
	if (typeof body === 'string') return body;
	if (body instanceof Blob) return await body.text();
	if (body instanceof URLSearchParams) return body.toString();
	if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
	return String(body);
}
