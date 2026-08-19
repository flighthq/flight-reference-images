import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { hashFile, writeCanonicalJson } from './json.js';
import { identityKey } from './paths.js';
import { readRepository } from './repository.js';
import type { RepositoryState } from './repository.js';
import { assertSchema } from './schemas.js';
import type { OracleManifest, ReferenceImageLock } from './types.js';

export interface CompleteFlightOptions {
  flightRoot: string;
  oracleCommit: string;
  oracleRoot: string;
  requestId: string;
}

export interface ReconcileFlightOptions {
  flightRoot: string;
  oracleCommit: string;
  oracleRoot: string;
  requestIds: readonly string[];
}

export interface ReconcileFlightResult {
  lock: ReferenceImageLock;
  removedRequestIds: string[];
  retainedChangedRequestIds: string[];
}

export async function completeFlight(options: Readonly<CompleteFlightOptions>): Promise<ReferenceImageLock> {
  const context = await completionContext(options);
  const sourceRequest = requireCurrentSourceRequest(context.state, options.requestId);

  const requestPath = join(context.flightRoot, 'reference-image-requests', `${options.requestId}.json`);
  const actualRequestSha256 = await hashFile(requestPath);
  if (actualRequestSha256 !== sourceRequest.requestSha256) {
    throw new Error(`Flight request checksum is ${actualRequestSha256}, expected ${sourceRequest.requestSha256}`);
  }

  await writeCanonicalJson(join(context.flightRoot, 'scripts', 'reference-image-lock.json'), context.lock);
  await unlink(requestPath);
  return context.lock;
}

export async function reconcileFlight(options: Readonly<ReconcileFlightOptions>): Promise<ReconcileFlightResult> {
  if (options.requestIds.length === 0) throw new Error('at least one current request id is required');
  const requiredRequestIds = new Set(options.requestIds);
  if (requiredRequestIds.size !== options.requestIds.length) throw new Error('current request ids must be unique');

  const context = await completionContext(options);
  for (const requestId of requiredRequestIds) requireCurrentSourceRequest(context.state, requestId);

  const removable: Array<{ id: string; path: string }> = [];
  const retainedChangedRequestIds: string[] = [];
  for (const sourceRequest of context.state.manifest.sourceRequests) {
    const path = join(context.flightRoot, 'reference-image-requests', `${sourceRequest.id}.json`);
    const actualRequestSha256 = await hashFileIfPresent(path);
    if (actualRequestSha256 === null) {
      if (requiredRequestIds.has(sourceRequest.id)) throw new Error(`Flight request ${sourceRequest.id} is missing`);
      continue;
    }
    if (actualRequestSha256 === sourceRequest.requestSha256) {
      removable.push({ id: sourceRequest.id, path });
      continue;
    }
    if (requiredRequestIds.has(sourceRequest.id)) {
      throw new Error(`Flight request checksum is ${actualRequestSha256}, expected ${sourceRequest.requestSha256}`);
    }
    retainedChangedRequestIds.push(sourceRequest.id);
  }

  await writeCanonicalJson(join(context.flightRoot, 'scripts', 'reference-image-lock.json'), context.lock);
  for (const request of removable) await unlink(request.path);
  return {
    lock: context.lock,
    removedRequestIds: removable.map((request) => request.id),
    retainedChangedRequestIds,
  };
}

interface CompletionContext {
  flightRoot: string;
  lock: ReferenceImageLock;
  state: RepositoryState;
}

async function completionContext(
  options: Readonly<Pick<CompleteFlightOptions, 'flightRoot' | 'oracleCommit' | 'oracleRoot'>>,
): Promise<CompletionContext> {
  if (!/^[0-9a-f]{40}$/u.test(options.oracleCommit)) throw new Error('oracle commit must be a full 40-character SHA');
  const oracleRoot = resolve(options.oracleRoot);
  const flightRoot = resolve(options.flightRoot);
  const state = await readRepository(oracleRoot);
  if (state.manifest.releaseTag === null) throw new Error('cannot complete Flight from the bootstrap manifest');
  const lock: ReferenceImageLock = {
    $schema:
      'https://raw.githubusercontent.com/flighthq/flight-reference-images/main/schemas/reference-image-lock.schema.json',
    manifestSha256: await hashFile(join(oracleRoot, 'manifest.json')),
    oracleCommit: options.oracleCommit,
    packs: Object.fromEntries(
      state.manifest.packs.map((pack) => [
        pack.id,
        {
          file: pack.file,
          images: Object.fromEntries(
            [...state.records.values()]
              .filter((record) => record.pack === pack.id)
              .map((record) => [identityKey(record.identity), { pixelSha256: record.pixelSha256 }]),
          ),
          sha256: pack.sha256,
        },
      ]),
    ),
    releaseTag: state.manifest.releaseTag,
    repository: 'flighthq/flight-reference-images',
    schemaVersion: 2,
  };
  assertSchema<ReferenceImageLock>('reference-image-lock', lock);
  return { flightRoot, lock, state };
}

function requireCurrentSourceRequest(
  state: Readonly<RepositoryState>,
  requestId: string,
): OracleManifest['sourceRequests'][number] {
  const sourceRequest = state.manifest.sourceRequests.find((entry) => entry.id === requestId);
  if (sourceRequest === undefined) throw new Error(`release does not name request ${requestId}`);
  const locator = state.locators.find((entry) =>
    entry.schemaVersion === 1 ? entry.requestId === requestId : entry.requestIds.includes(requestId),
  );
  if (locator === undefined || locator.releaseTag !== state.manifest.releaseTag) {
    throw new Error(`current release has no matching reviewed candidate locator for ${requestId}`);
  }
  return sourceRequest;
}

async function hashFileIfPresent(path: string): Promise<string | null> {
  try {
    return await hashFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
