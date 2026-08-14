import { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { create, extract, list } from 'tar';

import { canonicalJson, hashBytes, hashFile, readJson } from './json.js';
import { assertSafeRelativePath, findFiles, imagePath, resolveInside } from './paths.js';
import { readPng } from './png.js';
import { assertSchema } from './schemas.js';
import type { ManifestPack, OracleManifest, OracleRecord, PackImage, PackManifest } from './types.js';

export interface PackImageSource {
  path: string;
  record: OracleRecord;
}

export async function buildReleasePacks(
  sources: readonly PackImageSource[],
  releaseTag: string,
  outputDirectory: string,
): Promise<ManifestPack[]> {
  const byPack = new Map<string, PackImageSource[]>();
  for (const source of sources) {
    const entries = byPack.get(source.record.pack) ?? [];
    entries.push(source);
    byPack.set(source.record.pack, entries);
  }

  await mkdir(outputDirectory, { recursive: true });
  const packs: ManifestPack[] = [];
  for (const [pack, entries] of [...byPack].sort(([left], [right]) => left.localeCompare(right))) {
    const file = `${pack}-${releaseTag}.tgz`;
    const outputPath = join(outputDirectory, file);
    await buildPack(pack, entries, outputPath);
    packs.push({
      file,
      id: pack,
      imageCount: entries.length,
      sha256: await hashFile(outputPath),
      size: (await stat(outputPath)).size,
    });
  }
  return packs;
}

export async function downloadReleasePacks(
  manifest: Readonly<OracleManifest>,
  repository: string,
  outputDirectory: string,
): Promise<void> {
  if (manifest.releaseTag === null) {
    if (manifest.packs.length !== 0) throw new Error('bootstrap manifest cannot name packs');
    return;
  }
  await mkdir(outputDirectory, { recursive: true });

  for (const pack of manifest.packs) {
    const destination = join(outputDirectory, pack.file);
    try {
      if ((await hashFile(destination)) === pack.sha256) continue;
    } catch {
      // A missing or invalid cache entry is replaced only after the download verifies.
    }

    const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(manifest.releaseTag)}/${encodeURIComponent(pack.file)}`;
    const headers: Record<string, string> = {};
    if (process.env['GH_TOKEN']) headers['Authorization'] = `Bearer ${process.env['GH_TOKEN']}`;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`cannot download ${pack.file}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = hashBytes(bytes);
    if (actual !== pack.sha256) throw new Error(`${pack.file} checksum is ${actual}, expected ${pack.sha256}`);
    if (bytes.length !== pack.size) throw new Error(`${pack.file} size is ${bytes.length}, expected ${pack.size}`);

    const temporary = `${destination}.part-${process.pid}`;
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
  }
}

export async function extractVerifiedReleasePacks(
  manifest: Readonly<OracleManifest>,
  packDirectory: string,
  outputDirectory: string,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  for (const pack of manifest.packs) {
    const archivePath = join(packDirectory, pack.file);
    const actual = await hashFile(archivePath);
    if (actual !== pack.sha256) throw new Error(`${pack.file} checksum is ${actual}, expected ${pack.sha256}`);
    if ((await stat(archivePath)).size !== pack.size) throw new Error(`${pack.file} size does not match manifest`);
    const destination = join(outputDirectory, pack.id);
    await extractPack(archivePath, destination);
    await verifyExtractedPack(pack, destination);
  }
}

export async function verifyReleasePacks(
  manifest: Readonly<OracleManifest>,
  records: ReadonlyMap<string, OracleRecord>,
  packDirectory: string,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'flight-oracles-verify-'));
  try {
    await extractVerifiedReleasePacks(manifest, packDirectory, workspace);
    let comparisons = 0;
    for (const record of records.values()) {
      const path = imagePath(record.identity);
      const image = await readPng(join(workspace, record.pack, path));
      if (image.artifactSha256 !== record.artifactSha256) throw new Error(`${path} encoded-byte checksum differs`);
      if (image.pixelSha256 !== record.pixelSha256) throw new Error(`${path} decoded-pixel checksum differs`);
      if (image.width !== record.width || image.height !== record.height) throw new Error(`${path} dimensions differ`);
      comparisons += 1;
    }
    if (comparisons === 0) throw new Error('release verification compared zero images');
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

async function buildPack(pack: string, entries: readonly PackImageSource[], outputPath: string): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), `flight-oracles-${pack}-`));
  try {
    const images: PackImage[] = [];
    const seen = new Set<string>();
    for (const entry of [...entries].sort((left, right) =>
      imagePath(left.record.identity).localeCompare(imagePath(right.record.identity)),
    )) {
      const path = imagePath(entry.record.identity);
      if (seen.has(path)) throw new Error(`pack ${pack} repeats ${path}`);
      seen.add(path);
      const decoded = await readPng(entry.path);
      assertImageMatchesRecord(path, decoded, entry.record);
      const destination = resolveInside(workspace, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(entry.path, destination);
      images.push({
        artifactSha256: entry.record.artifactSha256,
        height: entry.record.height,
        path,
        pixelSha256: entry.record.pixelSha256,
        width: entry.record.width,
      });
    }

    const packManifest: PackManifest = { images, pack, schemaVersion: 1 };
    await writeFile(join(workspace, 'pack-manifest.json'), canonicalJson(packManifest));
    const paths = ['pack-manifest.json', ...images.map((image) => image.path)];
    await mkdir(dirname(outputPath), { recursive: true });
    await create(
      {
        cwd: workspace,
        file: outputPath,
        gzip: { level: 9, portable: true },
        noDirRecurse: true,
        noMtime: true,
        portable: true,
        strict: true,
      },
      paths,
    );
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

async function extractPack(archivePath: string, destination: string): Promise<void> {
  const entries: Array<{ path: string; type: string }> = [];
  await list({
    file: archivePath,
    onReadEntry: (entry) => {
      entries.push({ path: entry.path, type: entry.type });
    },
    strict: true,
  });
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = entry.path.startsWith('./') ? entry.path.slice(2) : entry.path;
    assertSafeRelativePath(path);
    if (seen.has(path)) throw new Error(`${basename(archivePath)} repeats archive entry ${path}`);
    seen.add(path);
    if (entry.type !== 'File' && entry.type !== 'Directory')
      throw new Error(`${basename(archivePath)} contains ${entry.type} ${path}`);
    if (entry.type === 'File' && path !== 'pack-manifest.json' && !/^images\/.+\.png$/u.test(path)) {
      throw new Error(`${basename(archivePath)} contains unexpected file ${path}`);
    }
  }
  await rm(destination, { force: true, recursive: true });
  await mkdir(destination, { recursive: true });
  await extract({ cwd: destination, file: archivePath, preservePaths: false, strict: true });
}

async function verifyExtractedPack(expected: Readonly<ManifestPack>, directory: string): Promise<void> {
  const value = await readJson(join(directory, 'pack-manifest.json'));
  assertSchema<PackManifest>('pack-manifest', value, `${expected.file}:pack-manifest.json`);
  if (value.pack !== expected.id)
    throw new Error(`${expected.file} declares pack ${value.pack}, expected ${expected.id}`);
  if (value.images.length !== expected.imageCount) {
    throw new Error(`${expected.file} declares ${value.images.length} images, expected ${expected.imageCount}`);
  }
  const declared = new Set(value.images.map((image) => image.path));
  if (declared.size !== value.images.length) throw new Error(`${expected.file} repeats an image path`);
  const actual = (await findFiles(join(directory, 'images'), '.png')).map((path) => `images/${path}`);
  for (const path of actual)
    if (!declared.has(path)) throw new Error(`${expected.file} contains undeclared image ${path}`);
  for (const image of value.images) {
    if (!actual.includes(image.path)) throw new Error(`${expected.file} is missing ${image.path}`);
    const decoded = await readPng(resolveInside(directory, image.path));
    if (decoded.artifactSha256 !== image.artifactSha256)
      throw new Error(`${expected.file}:${image.path} artifact hash differs`);
    if (decoded.pixelSha256 !== image.pixelSha256) throw new Error(`${expected.file}:${image.path} pixel hash differs`);
    if (decoded.width !== image.width || decoded.height !== image.height)
      throw new Error(`${expected.file}:${image.path} dimensions differ`);
  }
}

function assertImageMatchesRecord(
  path: string,
  decoded: Awaited<ReturnType<typeof readPng>>,
  record: Readonly<OracleRecord>,
): void {
  if (decoded.artifactSha256 !== record.artifactSha256)
    throw new Error(`${path} artifact hash differs from its record`);
  if (decoded.pixelSha256 !== record.pixelSha256) throw new Error(`${path} pixel hash differs from its record`);
  if (decoded.width !== record.width || decoded.height !== record.height)
    throw new Error(`${path} dimensions differ from its record`);
}
