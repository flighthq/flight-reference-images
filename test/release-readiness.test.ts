import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requireCurrentRelease } from '../src/release-readiness.js';
import type { OracleManifest } from '../src/types.js';

let workspace = '';
const originalGhToken = process.env['GH_TOKEN'];

beforeEach(async () => {
  process.env['GH_TOKEN'] = 'test-token';
  workspace = await mkdtemp(join(tmpdir(), 'flight-reference-images-readiness-test-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalGhToken === undefined) delete process.env['GH_TOKEN'];
  else process.env['GH_TOKEN'] = originalGhToken;
  await rm(workspace, { force: true, recursive: true });
});

describe('requireCurrentRelease', () => {
  it('fails before downloading packs when the relevant release workflow already failed', async () => {
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const runUrl = 'https://github.com/flighthq/flight-reference-images/actions/runs/123';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          workflow_runs: [{ conclusion: 'failure', head_sha: headSha, html_url: runUrl, status: 'completed' }],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      requireCurrentRelease({
        attempts: 60,
        manifest: unavailableManifest(),
        outputDirectory: workspace,
        repository: 'flighthq/flight-reference-images',
        repositoryRoot: '.',
        retryDelayMilliseconds: 10_000,
      }),
    ).rejects.toThrow(
      `manifest.json names unpublished release ${RELEASE_TAG}, and its latest release workflow failed: ${runUrl}`,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function unavailableManifest(): OracleManifest {
  return {
    packs: [],
    parentReleaseTag: null,
    releaseTag: RELEASE_TAG,
    schemaVersion: 1,
    sourceRequests: [],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

const RELEASE_TAG = `oracle-batch-${'a'.repeat(12)}`;
