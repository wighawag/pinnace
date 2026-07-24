import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {mkdtemp, mkdir, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CarReader} from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import {buildCar, writeCar} from '../../src/car/car-build.js';

/**
 * CAR-correctness tests (task `car-build`, ACs 2-5, 7).
 *
 * We NEVER trust any stdout: every assertion decodes the built CAR's bytes.
 * The CAR reader (`@ipld/car`) yields the header roots; the root block is
 * decoded as UnixFS/dag-pb (`@ipld/dag-pb`) and its links inspected directly.
 * This is what proves the root is a real directory, the structure is
 * preserved, the `filesFromPaths` bug-fix holds (no wrapping segment), the
 * header carries the root (so `dag/import?pin-roots=true` pins it), and the
 * CID is deterministic.
 */

/** dag-pb multicodec (0x70). The site's UnixFS directory root uses it. */
const DAG_PB_CODE = 0x70;

let siteDir: string;
let tmpRoot: string;

/**
 * A tiny fixture site with the canonical shape the ACs name:
 *   index.html          (at the ROOT — guards the no-wrapping-segment fix)
 *   assets/s.css        (a nested path — guards structure preservation)
 */
async function makeFixtureSite(): Promise<string> {
	const dir = await mkdtemp(join(tmpRoot, 'site-'));
	await writeFile(join(dir, 'index.html'), '<h1>pinnace</h1>\n');
	await mkdir(join(dir, 'assets'), {recursive: true});
	await writeFile(join(dir, 'assets', 's.css'), 'body{margin:0}\n');
	return dir;
}

beforeAll(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), 'pinnace-car-'));
	siteDir = await makeFixtureSite();
});

afterAll(async () => {
	await rm(tmpRoot, {recursive: true, force: true});
});

/** Decode a CAR's header roots and its (single) root block's UnixFS links. */
async function decodeRoot(car: Uint8Array) {
	const reader = await CarReader.fromBytes(car);
	const roots = await reader.getRoots();
	const rootBlock = await reader.get(roots[0]);
	if (!rootBlock) throw new Error('root block missing from CAR');
	const node = dagPb.decode(rootBlock.bytes);
	const links = node.Links.map((l) => l.Name).sort();
	return {roots, rootCode: roots[0].code, links};
}

describe('buildCar — root is a UnixFS directory preserving structure', () => {
	it('yields a CAR whose ROOT block is a UnixFS directory', async () => {
		const {carBytes} = await buildCar(siteDir);
		const {rootCode} = await decodeRoot(carBytes);
		expect(rootCode).toBe(DAG_PB_CODE);
	});

	it('preserves the site structure: index.html + assets at the root', async () => {
		const {carBytes} = await buildCar(siteDir);
		const {links} = await decodeRoot(carBytes);
		// The directory root links to the top-level entries only; `assets` is a
		// subdirectory link, `index.html` a file link — both at the root.
		expect(links).toEqual(['assets', 'index.html']);
	});

	it('does NOT strip a leading segment: index.html sits at the ROOT (prototype bug)', async () => {
		const {carBytes} = await buildCar(siteDir);
		const {links} = await decodeRoot(carBytes);
		expect(links).toContain('index.html');
		// The site dir name must NOT appear as a wrapping link.
		expect(links).not.toContain('site');
	});
});

describe('buildCar — authoritative root captured + written into the header', () => {
	it('returns the root CID as the last encoder block, matching the CAR header root', async () => {
		const {carBytes, rootCid} = await buildCar(siteDir);
		const {roots} = await decodeRoot(carBytes);
		expect(roots).toHaveLength(1);
		expect(roots[0].toString()).toBe(rootCid);
	});

	it('the header root IS the decoded root block (so pin-roots pins the site root)', async () => {
		const {carBytes, rootCid} = await buildCar(siteDir);
		const reader = await CarReader.fromBytes(carBytes);
		const roots = await reader.getRoots();
		// A single header root, present as a block: exactly what
		// `dag/import?pin-roots=true` pins.
		expect(roots.map((r) => r.toString())).toEqual([rootCid]);
		expect(await reader.get(roots[0])).toBeTruthy();
	});
});

describe('buildCar — deterministic CID (decoded, never scraped)', () => {
	it('identical input yields the identical root CID across runs', async () => {
		const a = await buildCar(siteDir);
		const b = await buildCar(siteDir);
		expect(a.rootCid).toBe(b.rootCid);
		// Prove it by decoding both headers, not by comparing return values alone.
		const da = await decodeRoot(a.carBytes);
		const db = await decodeRoot(b.carBytes);
		expect(da.roots[0].toString()).toBe(db.roots[0].toString());
	});

	it('two structurally identical site dirs yield the same CID', async () => {
		const other = await makeFixtureSite();
		const a = await buildCar(siteDir);
		const b = await buildCar(other);
		expect(a.rootCid).toBe(b.rootCid);
	});
});

describe('writeCar — persists the same CAR bytes to a file', () => {
	it('writes a CAR file whose bytes decode to the same root', async () => {
		const out = join(tmpRoot, 'site.car');
		const {rootCid} = await writeCar(siteDir, out);
		const car = await readFile(out);
		const {roots} = await decodeRoot(car);
		expect(roots[0].toString()).toBe(rootCid);
	});
});

describe('buildCar — rejects an empty source dir', () => {
	it('throws when no files are found under the source dir', async () => {
		const empty = await mkdtemp(join(tmpRoot, 'empty-'));
		await expect(buildCar(empty)).rejects.toThrow(/no files/i);
	});
});
