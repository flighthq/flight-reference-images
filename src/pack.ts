import { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { create, extract, list } from 'tar';

import { canonicalJson, errorMessage, hashBytes, hashFile, isRecord, readJson } from './json.js';
import { assertSafeRelativePath, findFiles, imagePath, resolveInside } from './paths.js';
import { readPng } from './png.js';
import { assertSchema } from './schemas.js';
import type { ManifestPack, OracleManifest, OracleRecord, PackImage, PackManifest } from './types.js';

export interface PackImageSource {
  path: string;
  record: OracleRecord;
}

export interface PackDownloadOptions {
  attempts?: number;
  retryDelayMilliseconds?: number;
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
  options: Readonly<PackDownloadOptions> = {},
): Promise<void> {
  if (manifest.releaseTag === null) {
    if (manifest.packs.length !== 0) throw new Error('bootstrap manifest cannot name packs');
    return;
  }
  await mkdir(outputDirectory, { recursive: true });
  const attempts = options.attempts ?? 1;
  const retryDelayMilliseconds = options.retryDelayMilliseconds ?? 0;
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error('pack download attempts must be positive');
  if (!Number.isSafeInteger(retryDelayMilliseconds) || retryDelayMilliseconds < 0) {
    throw new Error('pack download retry delay must be non-negative');
  }

  const pending: ManifestPack[] = [];
  for (const pack of manifest.packs) {
    const destination = join(outputDirectory, pack.file);
    try {
      if ((await hashFile(destination)) === pack.sha256) continue;
    } catch {
      // A missing or invalid cache entry is replaced only after the download verifies.
    }
    pending.push(pack);
  }
  if (pending.length === 0) return;

  const token = process.env['GH_TOKEN'];
  const authenticated = token !== undefined && token.length > 0;
  const assetIds = authenticated
    ? await resolveReleaseAssetIds(
        repository,
        manifest.releaseTag,
        pending.map((pack) => pack.file),
        token,
        attempts,
        retryDelayMilliseconds,
      )
    : undefined;

  for (const pack of pending) {
    const destination = join(outputDirectory, pack.file);
    const bytes = authenticated
      ? await downloadAuthenticatedReleaseAsset(
          repository,
          pack.file,
          assetIds?.get(pack.file),
          token,
          attempts,
          retryDelayMilliseconds,
        )
      : await downloadPublicReleaseAsset(repository, manifest.releaseTag, pack.file, attempts, retryDelayMilliseconds);
    const actual = hashBytes(bytes);
    if (actual !== pack.sha256) throw new Error(`${pack.file} checksum is ${actual}, expected ${pack.sha256}`);
    if (bytes.length !== pack.size) throw new Error(`${pack.file} size is ${bytes.length}, expected ${pack.size}`);

    const temporary = `${destination}.part-${process.pid}`;
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
  }
}

type AttemptResult<T> = { value: T } | { failure: string; retryable: boolean };

async function retryDownload<T>(
  label: string,
  attempts: number,
  retryDelayMilliseconds: number,
  operation: () => Promise<AttemptResult<T>>,
): Promise<T> {
  let lastFailure = 'asset is not available';
  let completedAttempts = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    completedAttempts = attempt;
    try {
      const result = await operation();
      if ('value' in result) return result.value;
      lastFailure = result.failure;
      if (!result.retryable) break;
    } catch (error) {
      lastFailure = errorMessage(error);
    }
    if (attempt < attempts && retryDelayMilliseconds > 0) {
      console.warn(
        `cannot download ${label} (attempt ${attempt}/${attempts}): ${lastFailure}; retrying in ${retryDelayMilliseconds}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMilliseconds));
    }
  }
  throw new Error(`cannot download ${label} after ${completedAttempts} attempt(s): ${lastFailure}`);
}

async function downloadPublicReleaseAsset(
  repository: string,
  releaseTag: string,
  file: string,
  attempts: number,
  retryDelayMilliseconds: number,
): Promise<Buffer> {
  const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(file)}`;
  return retryDownload(`${file} from ${releaseTag}`, attempts, retryDelayMilliseconds, async () => {
    const response = await fetch(url);
    return response.ok
      ? { value: Buffer.from(await response.arrayBuffer()) }
      : { failure: `HTTP ${response.status}`, retryable: retryableDownloadStatus(response.status) };
  });
}

async function resolveReleaseAssetIds(
  repository: string,
  releaseTag: string,
  files: readonly string[],
  token: string,
  attempts: number,
  retryDelayMilliseconds: number,
): Promise<Map<string, number>> {
  const repositoryPath = githubRepositoryPath(repository);
  const headers = githubApiHeaders(token, 'application/vnd.github+json');
  return retryDownload(`release ${releaseTag}`, attempts, retryDelayMilliseconds, async () => {
    const releaseResponse = await fetch(
      `https://api.github.com/repos/${repositoryPath}/releases/tags/${encodeURIComponent(releaseTag)}`,
      { headers },
    );
    if (!releaseResponse.ok) {
      return {
        failure: `release API returned HTTP ${releaseResponse.status}`,
        retryable: retryableDownloadStatus(releaseResponse.status),
      };
    }
    const release: unknown = await releaseResponse.json();
    if (!isRecord(release) || !Array.isArray(release['assets'])) {
      return { failure: 'release API response has no asset list', retryable: false };
    }
    const ids = new Map<string, number>();
    for (const asset of release['assets']) {
      if (!isRecord(asset) || typeof asset['name'] !== 'string' || !Number.isSafeInteger(asset['id'])) continue;
      const assetId = asset['id'] as number;
      if (assetId < 1) continue;
      if (ids.has(asset['name'])) {
        return { failure: `release contains multiple assets named ${asset['name']}`, retryable: false };
      }
      ids.set(asset['name'], assetId);
    }
    const missing = files.filter((file) => !ids.has(file));
    return missing.length === 0
      ? { value: ids }
      : { failure: `release is missing ${missing.join(', ')}`, retryable: true };
  });
}

async function downloadAuthenticatedReleaseAsset(
  repository: string,
  file: string,
  assetId: number | undefined,
  token: string,
  attempts: number,
  retryDelayMilliseconds: number,
): Promise<Buffer> {
  if (assetId === undefined) throw new Error(`release asset id is missing for ${file}`);
  const repositoryPath = githubRepositoryPath(repository);
  return retryDownload(file, attempts, retryDelayMilliseconds, async () => {
    const response = await fetch(`https://api.github.com/repos/${repositoryPath}/releases/assets/${assetId}`, {
      headers: githubApiHeaders(token, 'application/octet-stream'),
    });
    return response.ok
      ? { value: Buffer.from(await response.arrayBuffer()) }
      : {
          failure: `release asset API returned HTTP ${response.status}`,
          retryable: retryableDownloadStatus(response.status),
        };
  });
}

function githubRepositoryPath(repository: string): string {
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[a-z0-9_.-]+$/iu.test(part))) {
    throw new Error(`invalid GitHub repository ${repository}`);
  }
  return parts.map((part) => encodeURIComponent(part)).join('/');
}

function githubApiHeaders(token: string, accept: string): Record<string, string> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'User-Agent': 'flight-reference-images',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function retryableDownloadStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 409 || status === 429 || status >= 500;
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
  const workspace = await mkdtemp(join(tmpdir(), 'flight-reference-images-verify-'));
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
  const workspace = await mkdtemp(join(tmpdir(), `flight-reference-images-${pack}-`));
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
