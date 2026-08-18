import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  IntakePolicy,
  OracleManifest,
  PackConfiguration,
} from '../src/types.js';

let workspace = '';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'flight-reference-images-intake-test-'));
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
    const record = repository.records.get('oracles/functional/shape-basic/webgl.json');
    expect(record).toBeDefined();

    const replay = await replayPreparedIntake({
      outputDirectory: join(workspace, 'replay'),
      preparedDirectory,
      previousPackDirectory: join(workspace, 'previous-packs'),
      repositoryRoot: fixture.repositoryRoot,
    });
    expect(replay).toEqual(prepared);

    const flightRoot = join(workspace, 'flight');
    await mkdir(join(flightRoot, 'reference-image-requests'), { recursive: true });
    await mkdir(join(flightRoot, 'scripts'), { recursive: true });
    await copyFile(
      fixture.requestPath,
      join(flightRoot, 'reference-image-requests', 'shape-basic-webgl-2026-08-14.json'),
    );
    const lock = await completeFlight({
      flightRoot,
      oracleCommit: '8'.repeat(40),
      oracleRoot: fixture.repositoryRoot,
      requestId: 'shape-basic-webgl-2026-08-14',
    });
    expect(lock.schemaVersion).toBe(2);
    expect(lock.releaseTag).toBe(prepared.releaseTag);
    expect(lock.packs['functional-shapes']?.sha256).toBe(prepared.packs[0]?.sha256);
    expect(lock.packs['functional-shapes']?.images).toEqual({
      'functional/shape-basic/webgl': { pixelSha256: record?.pixelSha256 },
    });
    await expect(readFile(join(flightRoot, 'scripts', 'reference-image-lock.json'), 'utf8')).resolves.toBe(
      canonicalJson(lock),
    );
    await expect(readFile(join(flightRoot, 'scripts', 'oracle-lock.json'), 'utf8')).rejects.toThrow();
    await expect(
      readFile(join(flightRoot, 'reference-image-requests', 'shape-basic-webgl-2026-08-14.json')),
    ).rejects.toThrow();
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

  it('reports a replacement whose dimensions differ from the prior reference', async () => {
    const fixture = await makeFixture('captured');
    const firstPreparedDirectory = join(workspace, 'first-prepared');
    await installFirstRelease(fixture, firstPreparedDirectory);

    fixture.request.id = 'shape-basic-webgl-resized-2026-08-14';
    fixture.request.reason = 'replace the reference at a new size';
    fixture.candidate.requestId = fixture.request.id;
    await writeCanonicalJson(join(fixture.candidateDirectory, 'candidate.json'), fixture.candidate);
    await writeFile(
      join(fixture.candidateDirectory, 'images', 'functional', 'shape-basic', 'webgl.png'),
      makePng(3, 2),
    );
    await writeRequestAndEnvelope(fixture);

    const preparedDirectory = join(workspace, 'resized-prepared');
    await prepareFixture(fixture, preparedDirectory, join(firstPreparedDirectory, 'prospective-packs'));

    const report = await readFile(join(preparedDirectory, 'report', 'report.json'), 'utf8');
    expect(report).toContain('"status": "dimension-changed"');
    expect(report).toContain('expected 2x2, got 3x2');
    await expect(
      readFile(join(preparedDirectory, 'report', 'images', 'functional--shape-basic--webgl', 'delta.png')),
    ).rejects.toThrow();
  });

  it('rejects a request id already named by a release', async () => {
    const fixture = await makeFixture('captured');
    const firstPreparedDirectory = join(workspace, 'duplicate-first-prepared');
    await installFirstRelease(fixture, firstPreparedDirectory);

    await expect(
      prepareFixture(
        fixture,
        join(workspace, 'duplicate-second-prepared'),
        join(firstPreparedDirectory, 'prospective-packs'),
      ),
    ).rejects.toThrow(`request id ${fixture.request.id} was already used by a release`);
  });

  it('rejects overlapping request targets', async () => {
    const fixture = await makeFixture('captured');
    fixture.request.targets[0]!.renderers = ['webgl', 'webgl'];
    await writeRequestAndEnvelope(fixture);

    await expect(prepareFixture(fixture, join(workspace, 'overlapping'))).rejects.toThrow(
      'request overlaps target functional/shape-basic/webgl',
    );
  });

  it('rejects a capture produced at a different frame count', async () => {
    const fixture = await makeFixture('captured');
    const capture = fixture.candidate.captures[0];
    if (capture?.status !== 'captured' || capture.provenance === undefined) throw new Error('invalid test fixture');
    capture.provenance.frames = 2;
    await writeCanonicalJson(join(fixture.candidateDirectory, 'candidate.json'), fixture.candidate);

    await expect(prepareFixture(fixture, join(workspace, 'wrong-frame'))).rejects.toThrow(
      'captured at frame 2, request requires 1',
    );
  });

  it('does not reuse or overwrite an existing output directory', async () => {
    const fixture = await makeFixture('captured');
    const outputDirectory = join(workspace, 'existing-output');
    await mkdir(outputDirectory);
    await writeFile(join(outputDirectory, 'sentinel.txt'), 'keep me');

    await expect(prepareFixture(fixture, outputDirectory)).rejects.toThrow('output directory already exists');
    await expect(readFile(join(outputDirectory, 'sentinel.txt'), 'utf8')).resolves.toBe('keep me');
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

  it('rejects symbolic links before reading candidate-controlled paths', async () => {
    const fixture = await makeFixture('captured');
    const target = join(workspace, 'outside.txt');
    await writeFile(target, 'outside');
    await symlink(target, join(fixture.candidateDirectory, 'outside-link'));

    await expect(
      prepareIntake({
        candidateDirectory: fixture.candidateDirectory,
        envelopePath: fixture.envelopePath,
        outputDirectory: join(workspace, 'linked'),
        previousPackDirectory: join(workspace, 'previous-packs'),
        repositoryRoot: fixture.repositoryRoot,
        requestPath: fixture.requestPath,
      }),
    ).rejects.toThrow('non-regular entry outside-link');
  });
});

describe('assertRequestFreshness', () => {
  it('fires when an outstanding request exceeds the bounded pending window', () => {
    const envelope: DispatchEnvelope = {
      artifactDigest: `sha256:${'1'.repeat(64)}`,
      artifactId: 1,
      flightCommit: '2'.repeat(40),
      flightCommittedAt: '2026-07-01T00:00:00Z',
      repository: 'flighthq/flight',
      requestPath: 'reference-image-requests/expired.json',
      requestSha256: '3'.repeat(64),
      schemaVersion: 1,
      workflowRunId: 1,
    };
    expect(() => assertRequestFreshness(envelope, intakePolicy(), new Date('2026-08-14T00:00:00Z'))).toThrow(
      'maximum is 336',
    );
  });

  it('rejects a commit beyond the allowed future clock skew', () => {
    const envelope: DispatchEnvelope = {
      artifactDigest: `sha256:${'1'.repeat(64)}`,
      artifactId: 1,
      flightCommit: '2'.repeat(40),
      flightCommittedAt: '2026-08-14T00:10:01Z',
      repository: 'flighthq/flight',
      requestPath: 'reference-image-requests/future.json',
      requestSha256: '3'.repeat(64),
      schemaVersion: 1,
      workflowRunId: 1,
    };

    expect(() => assertRequestFreshness(envelope, intakePolicy(), new Date('2026-08-14T00:00:00Z'))).toThrow(
      'more than 10 minutes in the future',
    );
  });
});

describe('completeFlight', () => {
  it('requires a full oracle commit SHA before reading repository state', async () => {
    await expect(
      completeFlight({ flightRoot: workspace, oracleCommit: 'abc123', oracleRoot: workspace, requestId: 'request' }),
    ).rejects.toThrow('full 40-character SHA');
  });

  it('refuses to complete against the bootstrap manifest', async () => {
    const fixture = await makeFixture('captured');
    await expect(
      completeFlight({
        flightRoot: workspace,
        oracleCommit: '8'.repeat(40),
        oracleRoot: fixture.repositoryRoot,
        requestId: fixture.request.id,
      }),
    ).rejects.toThrow('bootstrap manifest');
  });

  it('requires the current release to name the requested completion', async () => {
    const fixture = await makeFixture('captured');
    await installFirstRelease(fixture, join(workspace, 'missing-request-prepared'));

    await expect(
      completeFlight({
        flightRoot: workspace,
        oracleCommit: '8'.repeat(40),
        oracleRoot: fixture.repositoryRoot,
        requestId: 'different-request',
      }),
    ).rejects.toThrow('release does not name request different-request');
  });

  it('refuses to remove a Flight request whose bytes moved after intake', async () => {
    const fixture = await makeFixture('captured');
    await installFirstRelease(fixture, join(workspace, 'moved-request-prepared'));
    const flightRoot = join(workspace, 'moved-request-flight');
    await mkdir(join(flightRoot, 'reference-image-requests'), { recursive: true });
    await mkdir(join(flightRoot, 'scripts'), { recursive: true });
    await writeCanonicalJson(join(flightRoot, 'reference-image-requests', `${fixture.request.id}.json`), {
      ...fixture.request,
      reason: 'changed after capture',
    });

    await expect(
      completeFlight({
        flightRoot,
        oracleCommit: '8'.repeat(40),
        oracleRoot: fixture.repositoryRoot,
        requestId: fixture.request.id,
      }),
    ).rejects.toThrow('Flight request checksum is');
    await expect(
      readFile(join(flightRoot, 'reference-image-requests', `${fixture.request.id}.json`)),
    ).resolves.toBeDefined();
  });
});

interface Fixture {
  candidate: CandidateManifest;
  candidateDirectory: string;
  envelope: DispatchEnvelope;
  envelopePath: string;
  repositoryRoot: string;
  request: FlightOracleRequest;
  requestPath: string;
}

async function makeFixture(status: 'captured' | 'missing'): Promise<Fixture> {
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
    browser: { name: 'chromium', playwrightVersion: '1.50.0', revision: 'chromium-1155', version: '131.0.0' },
    colorProfile: 'srgb',
    devicePixelRatio: 1,
    execution: { image: `ghcr.io/flighthq/capture@sha256:${'1'.repeat(64)}`, kind: 'container' as const },
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
  await writeCanonicalJson(join(repositoryRoot, 'intake-policy.json'), intakePolicy());
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
    requestPath: `reference-image-requests/${request.id}.json`,
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
  return { candidate, candidateDirectory, envelope, envelopePath, repositoryRoot, request, requestPath };
}

async function prepareFixture(
  fixture: Readonly<Fixture>,
  outputDirectory: string,
  previousPackDirectory = join(workspace, 'previous-packs'),
) {
  return prepareIntake({
    candidateDirectory: fixture.candidateDirectory,
    envelopePath: fixture.envelopePath,
    outputDirectory,
    previousPackDirectory,
    repositoryRoot: fixture.repositoryRoot,
    requestPath: fixture.requestPath,
  });
}

async function installFirstRelease(fixture: Readonly<Fixture>, preparedDirectory: string): Promise<void> {
  await prepareFixture(fixture, preparedDirectory);
  await applyPreparedIntake({
    artifactDigest: `sha256:${'9'.repeat(64)}`,
    artifactId: 222,
    preparedDirectory,
    repositoryRoot: fixture.repositoryRoot,
    workflowRunId: 333,
  });
}

async function writeRequestAndEnvelope(fixture: Fixture): Promise<void> {
  await writeCanonicalJson(fixture.requestPath, fixture.request);
  fixture.envelope.requestPath = `reference-image-requests/${fixture.request.id}.json`;
  fixture.envelope.requestSha256 = await hashFile(fixture.requestPath);
  await writeCanonicalJson(fixture.envelopePath, fixture.envelope);
}

function intakePolicy(): IntakePolicy {
  return {
    candidateArtifactRetentionDays: 30,
    maximumFutureSkewMinutes: 10,
    maximumImageBytes: 1024 * 1024,
    maximumImageHeight: 1024,
    maximumImagePixels: 1024 * 1024,
    maximumImageWidth: 1024,
    maximumRequestAgeHours: 336,
    schemaVersion: 1,
  };
}

function makePng(width = 2, height = 2): Buffer {
  const png = new PNG({ height, width });
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    png.data[offset] = (index * 71 + 17) % 256;
    png.data[offset + 1] = (index * 47 + 31) % 256;
    png.data[offset + 2] = (index * 29 + 53) % 256;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png, { colorType: 6, inputColorType: 6 });
}
