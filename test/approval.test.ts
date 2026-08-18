import { describe, expect, it } from 'vitest';

import { renderApprovalSummary, requestDisplayLabel } from '../src/approval.js';
import type { FlightOracleRequest } from '../src/types.js';

describe('approval summary', () => {
  it('derives a display-only entry label and lists every reviewed cell', () => {
    const request = makeRequest();
    const summary = renderApprovalSummary({
      releaseTag: 'oracle-request-id-123456789abc',
      reportUrl: 'https://example.test/report',
      request,
    });

    expect(requestDisplayLabel(request)).toBe('node-alpha');
    expect(summary).toContain('## Reference image approval: node-alpha');
    expect(summary).toContain('Request: `request-id`');
    expect(summary).toContain('| `node-alpha` | `webgl` |');
    expect(summary).toContain('| `node-alpha` | `webgpu` |');
    expect(summary).toContain('[Open the visual old/new/delta review artifact](https://example.test/report)');
  });

  it('summarizes multiple entries without turning the label into identity', () => {
    const request = makeRequest();
    request.id = 'another-request-id';
    request.targets[1]!.entry = 'node-beta';

    expect(requestDisplayLabel(request)).toBe('node-alpha + 1 more');
    expect(renderApprovalSummary({ releaseTag: 'release', reportUrl: 'report', request })).toContain(
      'Request: `another-request-id`',
    );
  });
});

function makeRequest(): FlightOracleRequest {
  const environmentId = `sha256-${'1'.repeat(64)}`;
  const build = { commit: '2'.repeat(40), dirty: [], dirtyOmitted: 0 };
  const capture = { environmentId, hostInstanceId: 'review-host' };
  return {
    frames: 1,
    id: 'request-id',
    reason: 'approve node alpha',
    schemaVersion: 3,
    subject: 'functional',
    targets: [
      {
        build: { ...build },
        capture: { ...capture },
        entry: 'node-alpha',
        pixelSha256: '3'.repeat(64),
        renderer: 'webgl',
      },
      {
        build: { ...build },
        capture: { ...capture },
        entry: 'node-alpha',
        pixelSha256: '4'.repeat(64),
        renderer: 'webgpu',
      },
    ],
  };
}
