import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { hashFile, writeCanonicalJson } from './json.js';
import { identityKey } from './paths.js';
import { readRepository } from './repository.js';
import { assertSchema } from './schemas.js';
import type { ReferenceImageLock } from './types.js';

export interface CompleteFlightOptions {
  flightRoot: string;
  oracleCommit: string;
  oracleRoot: string;
  requestId: string;
}

export async function completeFlight(options: Readonly<CompleteFlightOptions>): Promise<ReferenceImageLock> {
  if (!/^[0-9a-f]{40}$/u.test(options.oracleCommit)) throw new Error('oracle commit must be a full 40-character SHA');
  const oracleRoot = resolve(options.oracleRoot);
  const flightRoot = resolve(options.flightRoot);
  const state = await readRepository(oracleRoot);
  if (state.manifest.releaseTag === null) throw new Error('cannot complete Flight from the bootstrap manifest');
  const sourceRequest = state.manifest.sourceRequests.find((entry) => entry.id === options.requestId);
  if (sourceRequest === undefined) throw new Error(`release does not name request ${options.requestId}`);
  const locator = state.locators.find((entry) =>
    entry.schemaVersion === 1 ? entry.requestId === options.requestId : entry.requestIds.includes(options.requestId),
  );
  if (locator === undefined || locator.releaseTag !== state.manifest.releaseTag) {
    throw new Error(`current release has no matching reviewed candidate locator for ${options.requestId}`);
  }

  const requestPath = join(flightRoot, 'reference-image-requests', `${options.requestId}.json`);
  const actualRequestSha256 = await hashFile(requestPath);
  if (actualRequestSha256 !== sourceRequest.requestSha256) {
    throw new Error(`Flight request checksum is ${actualRequestSha256}, expected ${sourceRequest.requestSha256}`);
  }

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
  await writeCanonicalJson(join(flightRoot, 'scripts', 'reference-image-lock.json'), lock);
  await unlink(requestPath);
  return lock;
}
