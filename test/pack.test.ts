import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hashBytes, hashFile } from '../src/json.js';
import { buildReleasePacks, downloadReleasePacks, verifyReleasePacks } from '../src/pack.js';
import { readPng } from '../src/png.js';
import type { OracleManifest, OracleRecord } from '../src/types.js';

let workspace = '';
const originalGhToken = process.env['GH_TOKEN'];

beforeEach(async () => {
  delete process.env['GH_TOKEN'];
  workspace = await mkdtemp(join(tmpdir(), 'flight-reference-images-pack-test-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalGhToken === undefined) delete process.env['GH_TOKEN'];
  else process.env['GH_TOKEN'] = originalGhToken;
  await rm(workspace, { force: true, recursive: true });
});

describe('buildReleasePacks', () => {
  it('produces byte-identical archives from the same image and record', async () => {
    const source = await makeSource();
    const first = await buildReleasePacks([source], RELEASE_TAG, join(workspace, 'first'));
    const second = await buildReleasePacks([source], RELEASE_TAG, join(workspace, 'second'));

    expect(first).toEqual(second);
    expect(await hashFile(join(workspace, 'first', first[0]!.file))).toBe(
      await hashFile(join(workspace, 'second', second[0]!.file)),
    );
  });

  it('rejects source bytes that do not match the Git record', async () => {
    const source = await makeSource();
    source.record.artifactSha256 = '0'.repeat(64);

    await expect(buildReleasePacks([source], RELEASE_TAG, join(workspace, 'bad'))).rejects.toThrow(
      'artifact hash differs from its record',
    );
  });
});

describe('downloadReleasePacks', () => {
  it('downloads private release assets through the authenticated GitHub API', async () => {
    process.env['GH_TOKEN'] = 'test-token';
    const bytes = Buffer.from('pack bytes');
    const manifest = makeDownloadManifest(bytes);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ assets: [{ id: 42, name: manifest.packs[0]!.file }] }))
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch', fetchMock);

    await downloadReleasePacks(manifest, 'flighthq/flight-reference-images', workspace);

    expect(await readFile(join(workspace, manifest.packs[0]!.file))).toEqual(bytes);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.github.com/repos/flighthq/flight-reference-images/releases/tags/${RELEASE_TAG}`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer test-token' },
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.github.com/repos/flighthq/flight-reference-images/releases/assets/42',
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: { Accept: 'application/octet-stream', Authorization: 'Bearer test-token' },
    });
  });

  it('retries until the release and its complete asset set are published', async () => {
    process.env['GH_TOKEN'] = 'test-token';
    const bytes = Buffer.from('eventual pack bytes');
    const manifest = makeDownloadManifest(bytes);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ assets: [] }))
      .mockResolvedValueOnce(jsonResponse({ assets: [{ id: 43, name: manifest.packs[0]!.file }] }))
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch', fetchMock);

    await downloadReleasePacks(manifest, 'flighthq/flight-reference-images', workspace, {
      attempts: 3,
      retryDelayMilliseconds: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(await readFile(join(workspace, manifest.packs[0]!.file))).toEqual(bytes);
  });

  it('does not retry a release authentication failure', async () => {
    process.env['GH_TOKEN'] = 'bad-token';
    const manifest = makeDownloadManifest(Buffer.from('pack'));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadReleasePacks(manifest, 'flighthq/flight-reference-images', workspace, {
        attempts: 3,
        retryDelayMilliseconds: 0,
      }),
    ).rejects.toThrow('after 1 attempt(s): release API returned HTTP 403');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('verifyReleasePacks', () => {
  it('verifies the archive, pack manifest, encoded bytes, decoded pixels, and dimensions', async () => {
    const source = await makeSource();
    const packs = await buildReleasePacks([source], RELEASE_TAG, join(workspace, 'release'));
    const manifest = makeManifest(packs);

    await expect(
      verifyReleasePacks(
        manifest,
        new Map([['oracles/functional/shape-basic/webgl.json', source.record]]),
        join(workspace, 'release'),
      ),
    ).resolves.toBeUndefined();
  });

  it('fires on a corrupted pack before extraction', async () => {
    const source = await makeSource();
    const releaseDirectory = join(workspace, 'release');
    const packs = await buildReleasePacks([source], RELEASE_TAG, releaseDirectory);
    const archive = join(releaseDirectory, packs[0]!.file);
    const bytes = await readFile(archive);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    await writeFile(archive, bytes);

    await expect(
      verifyReleasePacks(makeManifest(packs), new Map([['record', source.record]]), releaseDirectory),
    ).rejects.toThrow('checksum is');
  });

  it('fires when a release compares zero images', async () => {
    const manifest: OracleManifest = {
      packs: [],
      parentReleaseTag: null,
      releaseTag: null,
      schemaVersion: 1,
      sourceRequests: [],
    };
    await expect(verifyReleasePacks(manifest, new Map(), workspace)).rejects.toThrow('compared zero images');
  });
});

async function makeSource(): Promise<{ path: string; record: OracleRecord }> {
  const path = join(workspace, 'source.png');
  const png = new PNG({ height: 1, width: 2 });
  png.data.set([20, 30, 40, 255, 50, 60, 70, 255]);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, PNG.sync.write(png, { colorType: 6, inputColorType: 6 }));
  const decoded = await readPng(path);
  return {
    path,
    record: {
      artifactSha256: decoded.artifactSha256,
      colorSpace: 'srgb',
      comparisonPolicyId: 'pixel-v1',
      environmentId: `sha256-${'a'.repeat(64)}`,
      flightCommit: 'b'.repeat(40),
      height: decoded.height,
      identity: { entry: 'shape-basic', renderer: 'webgl', subject: 'functional' },
      pack: 'functional-shapes',
      pixelFormat: 'rgba8',
      pixelSha256: decoded.pixelSha256,
      provenance: {
        frames: 1,
        sourceHash: 'c'.repeat(64),
        targetKind: 'webgl',
        verifyPublished: true,
        warmupFrames: 0,
      },
      request: { id: 'shape-basic-webgl-2026-08-14', sha256: 'd'.repeat(64) },
      schemaVersion: 1,
      width: decoded.width,
    },
  };
}

function makeManifest(packs: OracleManifest['packs']): OracleManifest {
  return {
    packs,
    parentReleaseTag: null,
    releaseTag: RELEASE_TAG,
    schemaVersion: 1,
    sourceRequests: [
      {
        flightCommit: 'b'.repeat(40),
        id: 'shape-basic-webgl-2026-08-14',
        requestSha256: 'd'.repeat(64),
      },
    ],
  };
}

function makeDownloadManifest(bytes: Buffer): OracleManifest {
  return makeManifest([
    {
      file: `functional-shapes-${RELEASE_TAG}.tgz`,
      id: 'functional-shapes',
      imageCount: 1,
      sha256: hashBytes(bytes),
      size: bytes.length,
    },
  ]);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

const RELEASE_TAG = `oracle-shape-basic-webgl-2026-08-14-${'e'.repeat(12)}`;
