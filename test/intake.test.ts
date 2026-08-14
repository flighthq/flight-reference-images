import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { completeFlight } from '../src/completion.js';
import { applyPreparedIntake, assertRequestFreshness, prepareIntake, replayPreparedIntake } from '../src/intake.js';
import { canonicalJson, hashBytes, hashFile, writeCanonicalJson } from '../src/json.js';
import { readRepository } from '../src/repository.js';
import type {
  CandidateManifest,
  ComparisonPolicy,
  DispatchEnvelope,
  EnvironmentDescriptor,
  FlightOracleRequest,
  OracleManifest,
  PackConfiguration,
} from '../src/types.js';

let workspace = '';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'flight-oracles-intake-test-'));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

describe('prepareIntake', () => {
  it('prepares, applies, and exactly replays the first release', async () => {
    const fixture = await makeFixture('captured');
    const preparedDirectory = join(workspace, 'prepared');
    const prepared = await prepareIntake({
      candidateDirectory: fixture.candidateDirectory,
      envelopePath: fixture.envelopePath,
      outputDirectory: preparedDirectory,
      previousPackDirectory: join(workspace, 'previous-packs'),
      repositoryRoot: fixture.repositoryRoot,
      requestPath: fixture.requestPath,
    });

    expect(prepared.records).toHaveLength(1);
    expect(prepared.packs).toHaveLength(1);
    expect(await readFile(join(preparedDirectory, 'report', 'report.json'), 'utf8')).toContain('"status": "added"');

    const locator = await applyPreparedIntake({
      artifactDigest: `sha256:${'9'.repeat(64)}`,
      artifactId: 222,
      preparedDirectory,
      repositoryRoot: fixture.repositoryRoot,
      workflowRunId: 333,
    });
    expect(locator.releaseTag).toBe(prepared.releaseTag);
    const repository = await readRepository(fixture.repositoryRoot);
    expect(repository.records.size).toBe(1);
    expect(repository.manifest.packs[0]?.imageCount).toBe(1);

    const replay = await replayPreparedIntake({
      outputDirectory: join(workspace, 'replay'),
      preparedDirectory,
      previousPackDirectory: join(workspace, 'previous-packs'),
      repositoryRoot: fixture.repositoryRoot,
    });
    expect(replay).toEqual(prepared);

    const flightRoot = join(workspace, 'flight');
    await mkdir(join(flightRoot, 'oracle-requests'), { recursive: true });
    await mkdir(join(flightRoot, 'scripts'), { recursive: true });
    await copyFile(fixture.requestPath, join(flightRoot, 'oracle-requests', 'shape-basic-webgl-2026-08-14.json'));
    const lock = await completeFlight({
      flightRoot,
      oracleCommit: '8'.repeat(40),
      oracleRoot: fixture.repositoryRoot,
      requestId: 'shape-basic-webgl-2026-08-14',
    });
    expect(lock.releaseTag).toBe(prepared.releaseTag);
    expect(lock.packs['functional-shapes']?.sha256).toBe(prepared.packs[0]?.sha256);
    await expect(readFile(join(flightRoot, 'oracle-requests', 'shape-basic-webgl-2026-08-14.json'))).rejects.toThrow();
  });

  it('lists a failed requested capture and refuses to construct a release', async () => {
    const fixture = await makeFixture('missing');
    const preparedDirectory = join(workspace, 'missing-prepared');

    await expect(
      prepareIntake({
        candidateDirectory: fixture.candidateDirectory,
        envelopePath: fixture.envelopePath,
        outputDirectory: preparedDirectory,
        previousPackDirectory: join(workspace, 'previous-packs'),
        repositoryRoot: fixture.repositoryRoot,
        requestPath: fixture.requestPath,
      }),
    ).rejects.toThrow('requested captures are missing');
    const report = await readFile(join(preparedDirectory, 'report', 'report.json'), 'utf8');
    expect(report).toContain('"status": "missing"');
    await expect(readFile(join(preparedDirectory, 'prepared-intake.json'))).rejects.toThrow();
  });

  it('rejects an undeclared sibling image instead of hiding collateral scope', async () => {
    const fixture = await makeFixture('captured');
    const extra = join(fixture.candidateDirectory, 'images', 'functional', 'shape-sibling', 'webgl.png');
    await mkdir(join(extra, '..'), { recursive: true });
    await writeFile(extra, makePng());

    await expect(
      prepareIntake({
        candidateDirectory: fixture.candidateDirectory,
        envelopePath: fixture.envelopePath,
        outputDirectory: join(workspace, 'out-of-scope'),
        previousPackDirectory: join(workspace, 'previous-packs'),
        repositoryRoot: fixture.repositoryRoot,
        requestPath: fixture.requestPath,
      }),
    ).rejects.toThrow('undeclared file');
  });
});

describe('assertRequestFreshness', () => {
  it('fires when an outstanding request exceeds the bounded pending window', () => {
    const envelope = {
      artifactDigest: `sha256:${'1'.repeat(64)}`,
      artifactId: 1,
      flightCommit: '2'.repeat(40),
      flightCommittedAt: '2026-07-01T00:00:00Z',
      repository: 'flighthq/flight' as const,
      requestPath: 'oracle-requests/expired.json',
      requestSha256: '3'.repeat(64),
      schemaVersion: 1 as const,
      workflowRunId: 1,
    };
    expect(() =>
      assertRequestFreshness(
        envelope,
        {
          candidateArtifactRetentionDays: 30,
          maximumFutureSkewMinutes: 10,
          maximumRequestAgeHours: 336,
          schemaVersion: 1,
        },
        new Date('2026-08-14T00:00:00Z'),
      ),
    ).toThrow('maximum is 336');
  });
});

async function makeFixture(status: 'captured' | 'missing'): Promise<{
  candidateDirectory: string;
  envelopePath: string;
  repositoryRoot: string;
  requestPath: string;
}> {
  const repositoryRoot = join(workspace, `repository-${status}`);
  await mkdir(join(repositoryRoot, 'candidates'), { recursive: true });
  await mkdir(join(repositoryRoot, 'comparison-policies'), { recursive: true });
  await mkdir(join(repositoryRoot, 'environments'), { recursive: true });
  await mkdir(join(repositoryRoot, 'oracles'), { recursive: true });

  const manifest: OracleManifest = {
    $schema: './schemas/manifest.schema.json',
    packs: [],
    parentReleaseTag: null,
    releaseTag: null,
    schemaVersion: 1,
    sourceRequests: [],
  };
  const packConfiguration: PackConfiguration = {
    $schema: './schemas/pack-config.schema.json',
    schemaVersion: 1,
    subjects: { functional: { defaultPack: 'functional-shapes' } },
  };
  const environmentPayload = {
    browser: { name: 'chromium', playwrightVersion: '1.50.0', version: '131.0.0' },
    colorProfile: 'srgb',
    containerImage: `ghcr.io/flighthq/capture@sha256:${'1'.repeat(64)}`,
    devicePixelRatio: 1,
    fonts: [{ family: 'Flight Test Sans', sha256: '2'.repeat(64) }],
    locale: 'en-US',
    renderer: { arguments: ['--use-angle=swiftshader'], implementation: 'SwiftShader' },
    schemaVersion: 1 as const,
    timezone: 'UTC',
    viewport: { height: 600, width: 800 },
  };
  const environmentId = `sha256-${hashBytes(canonicalJson(environmentPayload))}`;
  const environment: EnvironmentDescriptor = { ...environmentPayload, id: environmentId };
  const policy: ComparisonPolicy = {
    calibration: {
      corpusSha256: '3'.repeat(64),
      flightCommit: '4'.repeat(40),
      independentHosts: 2,
      notes: 'test calibration',
      runsPerHost: 2,
    },
    channelTolerance: 2,
    environmentId,
    id: 'pixel-v1',
    maximumChannelDelta: { mode: 'report' },
    maximumMismatchFraction: 0.001,
    schemaVersion: 1,
  };
  await writeCanonicalJson(join(repositoryRoot, 'manifest.json'), manifest);
  await writeCanonicalJson(join(repositoryRoot, 'intake-policy.json'), {
    candidateArtifactRetentionDays: 30,
    maximumFutureSkewMinutes: 10,
    maximumRequestAgeHours: 336,
    schemaVersion: 1,
  });
  await writeCanonicalJson(join(repositoryRoot, 'pack-config.json'), packConfiguration);
  await writeCanonicalJson(join(repositoryRoot, 'environments', `${environmentId}.json`), environment);
  await writeCanonicalJson(join(repositoryRoot, 'comparison-policies', 'pixel-v1.json'), policy);

  const request: FlightOracleRequest = {
    frames: 1,
    id: 'shape-basic-webgl-2026-08-14',
    reason: 'add the first reference',
    schemaVersion: 1,
    subject: 'functional',
    targets: [{ entry: 'shape-basic', renderers: ['webgl'] }],
  };
  const requestPath = join(workspace, `request-${status}.json`);
  await writeCanonicalJson(requestPath, request);
  const envelope: DispatchEnvelope = {
    artifactDigest: `sha256:${'5'.repeat(64)}`,
    artifactId: 100,
    flightCommit: '6'.repeat(40),
    flightCommittedAt: new Date().toISOString(),
    repository: 'flighthq/flight',
    requestPath: `oracle-requests/${request.id}.json`,
    requestSha256: await hashFile(requestPath),
    schemaVersion: 1,
    workflowRunId: 200,
  };
  const envelopePath = join(workspace, `envelope-${status}.json`);
  await writeCanonicalJson(envelopePath, envelope);

  const candidateDirectory = join(workspace, `candidate-${status}`);
  await mkdir(candidateDirectory, { recursive: true });
  const identity = { entry: 'shape-basic', renderer: 'webgl', subject: 'functional' };
  const candidate: CandidateManifest = {
    captures:
      status === 'captured'
        ? [
            {
              file: 'images/functional/shape-basic/webgl.png',
              identity,
              provenance: {
                frames: 1,
                sourceHash: '7'.repeat(64),
                targetKind: 'webgl',
                verifyPublished: true,
                warmupFrames: 0,
              },
              status,
            },
          ]
        : [{ error: 'page did not publish an image', identity, status }],
    comparisonPolicyId: 'pixel-v1',
    environmentId,
    requestId: request.id,
    schemaVersion: 1,
  };
  await writeCanonicalJson(join(candidateDirectory, 'candidate.json'), candidate);
  if (status === 'captured') {
    const image = join(candidateDirectory, 'images', 'functional', 'shape-basic', 'webgl.png');
    await mkdir(join(image, '..'), { recursive: true });
    await writeFile(image, makePng());
  }
  return { candidateDirectory, envelopePath, repositoryRoot, requestPath };
}

function makePng(): Buffer {
  const png = new PNG({ height: 2, width: 2 });
  png.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  return PNG.sync.write(png, { colorType: 6, inputColorType: 6 });
}
