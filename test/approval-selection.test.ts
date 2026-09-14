import { describe, expect, it } from 'vitest';

import { approvalBaseMismatch, selectPublishableApprovals } from '../src/approval-selection.js';
import { canonicalJson, hashBytes } from '../src/json.js';
import type { CandidateApproval, OracleRecord } from '../src/types.js';

describe('selectPublishableApprovals', () => {
  it('selects lexical non-overlapping approvals and explains each deferral', () => {
    const first = approval('alpha', null, ['oracles/functional/shared/webgl.json']);
    const overlap = approval('bravo', null, [
      'oracles/functional/shared/webgl.json',
      'oracles/functional/unique/webgl.json',
    ]);
    const disjoint = approval('charlie', null, ['oracles/functional/other/webgl.json']);

    const selection = selectPublishableApprovals([overlap, disjoint, first], new Map());

    expect(selection.selected.map((entry) => entry.requestId)).toEqual(['alpha', 'charlie']);
    expect(selection.deferred).toEqual([
      {
        reason: 'overlaps oracles/functional/shared/webgl.json claimed by request alpha',
        requestId: 'bravo',
        sha256: hashBytes(canonicalJson(overlap)),
      },
    ]);
  });

  it('gives a merged pending approval precedence and identifies a stale review base', () => {
    const currentRecord = record();
    const records = new Map([[PATH, currentRecord]]);
    const reserved = approval('reserved', hashBytes(canonicalJson(currentRecord)), [PATH]);
    const overlapping = approval('alpha', hashBytes(canonicalJson(currentRecord)), [PATH]);
    const stale = approval('stale', null, ['oracles/functional/stale/webgl.json']);
    const staleRecords = new Map(records).set('oracles/functional/stale/webgl.json', currentRecord);

    expect(selectPublishableApprovals([overlapping, stale], staleRecords, [reserved])).toMatchObject({
      deferred: [
        { reason: `overlaps ${PATH} claimed by request reserved`, requestId: 'alpha' },
        { reason: 'review base no longer matches oracles/functional/stale/webgl.json', requestId: 'stale' },
      ],
      selected: [],
    });
    expect(approvalBaseMismatch(stale, staleRecords)).toBe('oracles/functional/stale/webgl.json');
  });
});

const PATH = 'oracles/functional/shared/webgl.json';

function approval(requestId: string, baseSha256: string | null, paths: string[]): CandidateApproval {
  return {
    baseRecords: paths.map((path) => ({ path, sha256: baseSha256 })),
    candidateSha256: '1'.repeat(64),
    flightCommit: '2'.repeat(40),
    preparedArtifact: artifact(1),
    records: paths.map((path) => ({ path, sha256: '3'.repeat(64) })),
    requestId,
    requestSha256: '4'.repeat(64),
    schemaVersion: 1,
    sourceArtifact: artifact(2),
  };
}

function artifact(artifactId: number): CandidateApproval['preparedArtifact'] {
  return {
    artifactId,
    digest: `sha256:${'5'.repeat(64)}`,
    repository: 'flighthq/flight-reference-images',
    workflowRunId: 3,
  };
}

function record(): OracleRecord {
  return {
    artifactSha256: '6'.repeat(64),
    colorSpace: 'srgb',
    comparisonPolicyId: 'policy',
    environmentId: `sha256-${'7'.repeat(64)}`,
    flightCommit: '8'.repeat(40),
    height: 1,
    identity: { entry: 'shared', renderer: 'webgl', subject: 'functional' },
    pack: 'pack',
    pixelFormat: 'rgba8',
    pixelSha256: '9'.repeat(64),
    provenance: { frames: 1, sourceHash: null, targetKind: null, verifyPublished: false, warmupFrames: 0 },
    request: { id: 'request', sha256: 'a'.repeat(64) },
    schemaVersion: 1,
    width: 1,
  };
}
