import { describe, expect, it } from 'vitest';

import { resolveBatchApprovalArtifacts } from '../src/batch-approval.js';

describe('resolveBatchApprovalArtifacts', () => {
  it('binds each prepared candidate to its review artifact in request order', () => {
    const second = artifactSet('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 20, 21);
    const first = artifactSet('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 11);

    expect(
      resolveBatchApprovalArtifacts([{ artifacts: [...second, ...first] }], RUN_ID, [
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ]),
    ).toEqual({
      ready: [
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
      ],
      skipped: [],
    });
  });

  it('defers an incomplete candidate without blocking complete candidates', () => {
    const [candidate] = artifactSet('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 11);
    const complete = artifactSet('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 20, 21);

    expect(
      resolveBatchApprovalArtifacts([{ artifacts: [candidate, ...complete] }], RUN_ID, [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ]),
    ).toEqual({
      ready: [
        {
          artifactDigest: DIGEST,
          artifactId: 20,
          reportId: 21,
          requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ],
      skipped: [
        {
          reason: 'missing visual review',
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      ],
    });
  });

  it('still rejects artifacts outside the validated dispatch membership', () => {
    const artifacts = artifactSet('unexpected', 10, 11);

    expect(() => resolveBatchApprovalArtifacts([{ artifacts }], RUN_ID, ['expected'])).toThrow(
      'batch produced artifacts for unexpected request(s): unexpected',
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
