import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeCanonicalJson } from '../src/json.js';
import { readRepository } from '../src/repository.js';
import type { OracleManifest, PackConfiguration } from '../src/types.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'flight-oracles-repository-test-'));
  for (const directory of ['candidates', 'comparison-policies', 'environments', 'oracles']) {
    await mkdir(join(root, directory));
  }
  await writeCanonicalJson(join(root, 'intake-policy.json'), {
    candidateArtifactRetentionDays: 30,
    maximumFutureSkewMinutes: 10,
    maximumImageBytes: 1024 * 1024,
    maximumImageHeight: 1024,
    maximumImagePixels: 1024 * 1024,
    maximumImageWidth: 1024,
    maximumRequestAgeHours: 336,
    schemaVersion: 1,
  });
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe('readRepository', () => {
  it('rejects an invalid pack regex even before the first record uses it', async () => {
    await writeCanonicalJson(join(root, 'manifest.json'), bootstrapManifest());
    await writeCanonicalJson(join(root, 'pack-config.json'), {
      schemaVersion: 1,
      subjects: { functional: { defaultPack: 'functional-other', rules: [{ entryPattern: '[', pack: 'bad' }] } },
    } satisfies PackConfiguration);

    await expect(readRepository(root)).rejects.toThrow('has invalid rule');
  });

  it('rejects duplicate manifest pack ids instead of collapsing them in a map', async () => {
    const releaseTag = `oracle-test-request-${'a'.repeat(12)}`;
    await writeCanonicalJson(join(root, 'manifest.json'), {
      packs: [
        {
          file: `functional-${releaseTag}.tgz`,
          id: 'functional',
          imageCount: 1,
          sha256: 'b'.repeat(64),
          size: 1,
        },
        {
          file: `functional-${releaseTag}.tgz`,
          id: 'functional',
          imageCount: 1,
          sha256: 'b'.repeat(64),
          size: 1,
        },
      ],
      parentReleaseTag: null,
      releaseTag,
      schemaVersion: 1,
      sourceRequests: [{ flightCommit: 'c'.repeat(40), id: 'test-request', requestSha256: 'd'.repeat(64) }],
    } satisfies OracleManifest);
    await writeCanonicalJson(join(root, 'pack-config.json'), {
      schemaVersion: 1,
      subjects: { functional: { defaultPack: 'functional' } },
    } satisfies PackConfiguration);

    await expect(readRepository(root)).rejects.toThrow('repeats pack id functional');
  });
});

function bootstrapManifest(): OracleManifest {
  return {
    packs: [],
    parentReleaseTag: null,
    releaseTag: null,
    schemaVersion: 1,
    sourceRequests: [],
  };
}
