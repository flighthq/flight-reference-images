import { describe, expect, it } from 'vitest';

import { expandBatchDispatch } from '../src/dispatch.js';
import type { BatchDispatchEnvelope } from '../src/types.js';

describe('expandBatchDispatch', () => {
  it('validates and deterministically expands one run into v1 candidate envelopes', () => {
    const batch = makeBatch();
    batch.candidates.push({
      artifactDigest: `sha256:${'6'.repeat(64)}`,
      artifactId: 124,
      requestPath: 'reference-image-requests/alpha.json',
      requestSha256: '5'.repeat(64),
    });

    expect(expandBatchDispatch(batch)).toEqual([
      {
        artifactDigest: `sha256:${'6'.repeat(64)}`,
        artifactId: 124,
        flightCommit: '1'.repeat(40),
        repository: 'flighthq/flight',
        requestPath: 'reference-image-requests/alpha.json',
        requestSha256: '5'.repeat(64),
        schemaVersion: 1,
        workflowRunId: 456,
      },
      {
        artifactDigest: `sha256:${'4'.repeat(64)}`,
        artifactId: 123,
        flightCommit: '1'.repeat(40),
        repository: 'flighthq/flight',
        requestPath: 'reference-image-requests/zulu.json',
        requestSha256: '3'.repeat(64),
        schemaVersion: 1,
        workflowRunId: 456,
      },
    ]);
  });

  it('rejects duplicate request paths even when their artifact identities differ', () => {
    const batch = makeBatch();
    batch.candidates.push({
      ...batch.candidates[0]!,
      artifactDigest: `sha256:${'7'.repeat(64)}`,
      artifactId: 999,
    });

    expect(() => expandBatchDispatch(batch)).toThrow('repeats request path');
  });

  it('rejects an artifact reused for two requests', () => {
    const batch = makeBatch();
    batch.candidates.push({
      ...batch.candidates[0]!,
      requestPath: 'reference-image-requests/different.json',
      requestSha256: '8'.repeat(64),
    });

    expect(() => expandBatchDispatch(batch)).toThrow('repeats artifact id');
  });

  it('rejects a batch larger than the GitHub matrix limit', () => {
    const batch = makeBatch();
    batch.candidates = Array.from({ length: 257 }, (_, index) => ({
      artifactDigest: `sha256:${index.toString(16).padStart(64, '0')}`,
      artifactId: index + 1,
      requestPath: `reference-image-requests/request-${index}.json`,
      requestSha256: index.toString(16).padStart(64, '0'),
    }));

    expect(() => expandBatchDispatch(batch)).toThrow('must NOT have more than 256 items');
  });

  it('fails closed on unversioned or incomplete additions', () => {
    expect(() => expandBatchDispatch({ ...makeBatch(), quietAddition: true })).toThrow(
      'must NOT have additional properties ("quietAddition")',
    );
    const batch = makeBatch();
    const { artifactDigest: ignored, ...withoutDigest } = batch.candidates[0]!;
    void ignored;
    expect(() => expandBatchDispatch({ ...batch, candidates: [withoutDigest] })).toThrow(
      "must have required property 'artifactDigest'",
    );
  });
});

function makeBatch(): BatchDispatchEnvelope {
  return {
    candidates: [
      {
        artifactDigest: `sha256:${'4'.repeat(64)}`,
        artifactId: 123,
        requestPath: 'reference-image-requests/zulu.json',
        requestSha256: '3'.repeat(64),
      },
    ],
    flightCommit: '1'.repeat(40),
    repository: 'flighthq/flight',
    schemaVersion: 2,
    workflowRunId: 456,
  };
}
