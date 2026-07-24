/**
 * In-process **CAR** (Content Addressable aRchive) builder — the default and
 * primary deploy artifact (CONTEXT.md `CAR`; spec user stories 4-6).
 *
 * Given a site SOURCE DIRECTORY, this builds a CAR whose root is a real UnixFS
 * DIRECTORY preserving the site structure (`index.html`, `assets/...`). The DAG
 * is built entirely IN-PROCESS via the `ipfs-car` library (no external CLI, no
 * output scraping), so the root CID is authoritative and the build reproducible.
 *
 * The scheme (ported, not copied, from the reference prototype
 * `~/searches/ipfs-hetzner/deploy-car.mjs`):
 *
 *   1. `filesFromPaths([sourceDir])` yields the directory's files with
 *      SITE-RELATIVE paths (`index.html`, `assets/s.css`) and NO wrapping
 *      segment. We pass them straight in: the CAR root IS the site dir. (An
 *      earlier prototype wrongly stripped a leading segment; that bug is fixed
 *      here and guarded by a test asserting `index.html` sits at the root.)
 *   2. Pipe the files through `createDirectoryEncoderStream`, buffering every
 *      emitted block and capturing the LAST block's CID as the directory root
 *      (authoritative — captured from the encoder, NEVER scraped from text).
 *   3. Re-encode the buffered blocks with `new CAREncoderStream([rootCid])` so
 *      the CAR HEADER carries the root. That is what makes
 *      `dag/import?pin-roots=true` pin the site root on every node.
 *
 * The build BUFFERS blocks in memory (fine for normal static sites; streaming
 * very large sites is explicitly out of scope for v1 — see the spec).
 */
import {writeFile} from 'node:fs/promises';
import {
	createDirectoryEncoderStream,
	CAREncoderStream,
	type Block,
} from 'ipfs-car';
import {filesFromPaths} from 'files-from-path';

/** The result of building a CAR: its raw bytes and its authoritative root CID. */
export interface BuiltCar {
	/** The complete CAR file bytes (header carries {@link BuiltCar.rootCid}). */
	readonly carBytes: Uint8Array;
	/** The site's UnixFS directory root CID, as the LAST encoder block. */
	readonly rootCid: string;
}

/**
 * Build a CAR for a site source directory, entirely in-process.
 *
 * @param sourceDir the site's built output directory (its CONTENTS become the
 *   CAR root — the directory itself is NOT wrapped in an extra segment).
 * @returns the CAR bytes plus the authoritative root CID (the last block the
 *   directory encoder emits, mirrored into the CAR header).
 * @throws if no files are found under `sourceDir` (nothing to deploy).
 */
export async function buildCar(sourceDir: string): Promise<BuiltCar> {
	// filesFromPaths([sourceDir]) already yields SITE-RELATIVE paths
	// ("index.html", "assets/s.css"). Do NOT strip a leading segment.
	const files = await filesFromPaths([sourceDir]);
	if (files.length === 0) {
		throw new Error(`no files found under ${sourceDir}`);
	}

	// Pass 1: encode the directory, buffering blocks and capturing the root CID
	// as the LAST emitted block. The header roots are patched in pass 2, so we
	// encode with an empty root list here and discard the resulting stream.
	const blocks: Block[] = [];
	let rootBlock: Block | undefined;
	await createDirectoryEncoderStream(files)
		.pipeThrough(
			new TransformStream({
				transform(block: Block, controller) {
					// The directory root is the LAST block the encoder emits.
					rootBlock = block;
					blocks.push(block);
					controller.enqueue(block);
				},
			}),
		)
		.pipeThrough(new CAREncoderStream([]))
		.pipeTo(new WritableStream());

	if (!rootBlock) {
		// Unreachable given files.length > 0, but keeps the root authoritative.
		throw new Error(`encoder produced no blocks for ${sourceDir}`);
	}
	const rootCid = rootBlock.cid.toString();

	// Pass 2: re-encode the SAME buffered blocks WITH the known root in the CAR
	// header, so `dag/import?pin-roots=true` pins the site root.
	const chunks: Uint8Array[] = [];
	const pending = blocks.slice();
	const source = new ReadableStream<Block>({
		pull(controller) {
			const next = pending.shift();
			if (next) controller.enqueue(next);
			else controller.close();
		},
	});
	await source.pipeThrough(new CAREncoderStream([rootBlock.cid])).pipeTo(
		new WritableStream({
			write(chunk) {
				chunks.push(chunk);
			},
		}),
	);

	return {carBytes: concatChunks(chunks), rootCid};
}

/**
 * Build a CAR for `sourceDir` and write it to `outPath`.
 *
 * A thin convenience over {@link buildCar} for the deploy path that persists a
 * CAR to disk before importing it into each node. Returns the same
 * {@link BuiltCar} (its `carBytes` are exactly the bytes written).
 */
export async function writeCar(
	sourceDir: string,
	outPath: string,
): Promise<BuiltCar> {
	const built = await buildCar(sourceDir);
	await writeFile(outPath, built.carBytes);
	return built;
}

/** Concatenate CAR stream chunks into one contiguous byte array. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
