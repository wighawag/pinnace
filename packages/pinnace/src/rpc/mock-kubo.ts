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

/** One multipart file part the mock extracted from a `FormData` body. */
export interface RecordedFilePart {
	/** The multipart field name (Kubo's file-upload endpoints expect `file`). */
	field: string;
	/** The optional filename the part was appended with. */
	filename?: string;
	/** The part's bytes. */
	bytes: Uint8Array;
}

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
	/**
	 * The effective request `content-type`. For a `FormData` body this is
	 * `multipart/form-data` (real `fetch` sets it, WITH a boundary, when it
	 * serialises FormData) even though the caller must NOT hand-set it — the
	 * mock derives it here so tests can assert the multipart contract Kubo
	 * requires for its file-upload endpoints.
	 */
	contentType?: string;
	/**
	 * When the body was a `FormData` (a `multipart/form-data` upload), the file
	 * parts it carried. Empty/undefined for non-multipart bodies. Kubo's
	 * `add`, `dag/import` and `key/import` require at least one file part under
	 * the field name `file`.
	 */
	fileParts?: RecordedFilePart[];
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
		const {bodyText, contentType, fileParts} = await inspectBody(
			init?.body,
			headers,
		);
		this.requests.push({
			method: init?.method ?? 'GET',
			path,
			query: new URLSearchParams(url.search),
			headers,
			bodyText,
			contentType,
			fileParts,
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

/**
 * Inspect a fetch body the way a real `fetch` would surface it to Kubo:
 * derive the effective `content-type` and, for a `multipart/form-data`
 * (`FormData`) body, extract the file parts. This is what lets the mock
 * ENFORCE Kubo's real upload contract (multipart + a `file` part) instead of
 * merely recording raw bytes — the fidelity gap that let raw octet-stream
 * uploads ship and then fail against a live daemon.
 */
async function inspectBody(
	body: unknown,
	headers: Record<string, string>,
): Promise<{
	bodyText: string;
	contentType?: string;
	fileParts?: RecordedFilePart[];
}> {
	if (body instanceof FormData) {
		// Real `fetch` serialises a FormData as `multipart/form-data; boundary=…`
		// and IGNORES any hand-set content-type. Model that here.
		const fileParts: RecordedFilePart[] = [];
		const textLines: string[] = [];
		// This TS `lib` (dom) types FormData without `entries()`/an iterator, so
		// collect the parts via `forEach` (which IS typed) then process them.
		const entries: Array<[string, FormDataEntryValue]> = [];
		body.forEach((value, field) => {
			entries.push([field, value]);
		});
		for (const [field, value] of entries) {
			if (value instanceof Blob) {
				const bytes = new Uint8Array(await value.arrayBuffer());
				const filename =
					typeof (value as File).name === 'string'
						? (value as File).name
						: undefined;
				fileParts.push({field, filename, bytes});
			} else {
				textLines.push(`${field}=${String(value)}`);
			}
		}
		return {
			bodyText: textLines.join('&'),
			contentType: 'multipart/form-data',
			fileParts,
		};
	}
	return {
		bodyText: await bodyToText(body),
		contentType: headers['content-type'],
	};
}

/** Best-effort stringify of a non-multipart fetch body for recording. */
async function bodyToText(body: unknown): Promise<string> {
	if (body === undefined || body === null) return '';
	if (typeof body === 'string') return body;
	if (body instanceof Blob) return await body.text();
	if (body instanceof URLSearchParams) return body.toString();
	if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
	return String(body);
}
