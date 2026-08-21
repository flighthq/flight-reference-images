import { describe, expect, it } from 'vitest';

import { resolveBatchApprovalArtifacts } from '../src/batch-approval.js';

describe('resolveBatchApprovalArtifacts', () => {
  it('binds each prepared candidate to its review artifact in request order', () => {
    const second = artifactSet('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 20, 21);
    const first = artifactSet('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 11);

    expect(resolveBatchApprovalArtifacts([{ artifacts: [...second, ...first] }], RUN_ID, 2)).toEqual([
      {
        artifactDigest: DIGEST,
        artifactId: 10,
        reportId: 11,
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      {
        artifactDigest: DIGEST,
        artifactId: 20,
        reportId: 21,
        requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    ]);
  });

  it('rejects an incomplete batch artifact set before any approval is written', () => {
    const [candidate] = artifactSet('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 11);

    expect(() => resolveBatchApprovalArtifacts([{ artifacts: [candidate] }], RUN_ID, 1)).toThrow(
      'batch produced 1 candidate and 0 review artifacts; expected 1 of each',
    );
  });
});

function artifactSet(requestId: string, artifactId: number, reportId: number): Array<Record<string, unknown>> {
  return [
    {
      digest: DIGEST,
      expired: false,
      id: artifactId,
      name: `oracle-candidate-${requestId}-${RUN_ID}`,
    },
    {
      digest: DIGEST,
      expired: false,
      id: reportId,
      name: `oracle-review-${requestId}-${RUN_ID}`,
    },
  ];
}

const DIGEST = `sha256:${'a'.repeat(64)}`;
const RUN_ID = 123;
