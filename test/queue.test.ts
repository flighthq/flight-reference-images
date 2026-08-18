import { describe, expect, it } from 'vitest';

import { selectApprovalQueue } from '../src/queue.js';
import type { ApprovalPull } from '../src/queue.js';
import type { OracleManifest } from '../src/types.js';

describe('approval queue', () => {
  it('discards released requests and selects the oldest remaining approval', () => {
    const selection = selectApprovalQueue(
      [pull(8, 'new-request'), pull(6, 'released-request')],
      manifest('released-request'),
      'flighthq/flight-reference-images',
    );

    expect(selection.obsolete.map((entry) => entry.number)).toEqual([6]);
    expect(selection.selected?.number).toBe(8);
    expect(selection.selected?.requestId).toBe('new-request');
  });

  it('repairs an explicitly requested obsolete head while advancing the next approval', () => {
    const selection = selectApprovalQueue(
      [pull(6, 'released-request'), pull(8, 'new-request')],
      manifest('released-request'),
      'flighthq/flight-reference-images',
      6,
    );

    expect(selection.obsolete.map((entry) => entry.number)).toEqual([6]);
    expect(selection.selected?.number).toBe(8);
  });

  it('still refuses a later actionable approval', () => {
    expect(() =>
      selectApprovalQueue(
        [pull(8, 'first-request'), pull(9, 'later-request')],
        manifest(),
        'flighthq/flight-reference-images',
        9,
      ),
    ).toThrow('PR #9 is not next; refresh and merge #8 first');
  });

  it('can close an obsolete-only queue without selecting work', () => {
    const selection = selectApprovalQueue(
      [pull(6, 'released-request')],
      manifest('released-request'),
      'flighthq/flight-reference-images',
    );

    expect(selection.obsolete.map((entry) => entry.number)).toEqual([6]);
    expect(selection.selected).toBeNull();
  });
});

function pull(number: number, requestId: string): ApprovalPull {
  return {
    base: { ref: 'main' },
    head: {
      ref: `oracle/${requestId}-${1000 + number}`,
      repo: { full_name: 'flighthq/flight-reference-images' },
      sha: String(number).repeat(40),
    },
    number,
  };
}

function manifest(...requestIds: string[]): OracleManifest {
  return {
    packs: [],
    parentReleaseTag: null,
    releaseTag: null,
    schemaVersion: 1,
    sourceRequests: requestIds.map((id) => ({ flightCommit: '1'.repeat(40), id, requestSha256: '2'.repeat(64) })),
  };
}
