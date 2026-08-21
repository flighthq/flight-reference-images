import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { completeFlight, reconcileFlight } from '../src/completion.js';
import {
  applyPreparedIntake,
  applyPreparedBatch,
  approvePreparedIntake,
  assertRequestFreshness,
  prepareIntake,
  prepareApprovedBatch,
  replayPreparedBatch,
  replayPreparedIntake,
  verifyPreparedApproval,
} from '../src/intake.js';
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
  RequestImageDifferences,
} from '../src/types.js';

let workspace = '';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'flight-reference-images-intake-test-'));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

describe('prepareIntake', () => {
  it('writes an independently mergeable approval without changing release state', async () => {
    const fixture = await makeFixture('captured');
    const preparedDirectory = join(workspace, 'approval-prepared');
    await prepareFixture(fixture, preparedDirectory);
    await rm(join(preparedDirectory, 'prospective-packs'), { recursive: true });
    await rm(join(preparedDirectory, 'report'), { recursive: true });
    const before = await readFile(join(fixture.repositoryRoot, 'manifest.json'), 'utf8');

    const approval = await approvePreparedIntake({
      artifactDigest: `sha256:${'9'.repeat(64)}`,
      artifactId: 222,
      preparedDirectory,
      repositoryRoot: fixture.repositoryRoot,
      workflowRunId: 333,
    });

    expect(approval.requestId).toBe(fixture.request.id);
    expect(approval.baseRecords).toEqual([{ path: 'oracles/functional/shape-basic/webgl.json', sha256: null }]);
    expect(approval.records).toHaveLength(1);
    await verifyPreparedApproval(approval, preparedDirectory);
    await expect(readFile(join(fixture.repositoryRoot, 'manifest.json'), 'utf8')).resolves.toBe(before);
    expect((await readRepository(fixture.repositoryRoot)).records.size).toBe(0);
  });

  it('materializes and exactly replays approved candidates as a separate batch', async () => {
    const fixture = await makeFixture('captured');
    const sibling = await makeSiblingFixture(fixture);
    const preparedRoot = join(workspace, 'approved-inputs');
    const preparedDirectory = join(preparedRoot, fixture.request.id);
    const siblingPreparedDirectory = join(preparedRoot, sibling.request.id);
    await prepareFixture(fixture, preparedDirectory);
    await prepareFixture(sibling, siblingPreparedDirectory);
    await approvePreparedIntake({
      artifactDigest: `sha256:${'9'.repeat(64)}`,
      artifactId: 222,
      preparedDirectory,
      repositoryRoot: fixture.repositoryRoot,
      workflowRunId: 333,
    });
    await approvePreparedIntake({
      artifactDigest: `sha256:${'7'.repeat(64)}`,
      artifactId: 223,
      preparedDirectory: siblingPreparedDirectory,
      repositoryRoot: fixture.repositoryRoot,
      workflowRunId: 334,
    });

    const batchDirectory = join(workspace, 'prepared-batch');
    const batch = await prepareApprovedBatch({
      outputDirectory: batchDirectory,
      preparedRoot,
      previousPackDirectory: join(workspace, 'previous-packs'),
      repositoryRoot: fixture.repositoryRoot,
    });
    expect(batch.requestIds).toEqual([fixture.request.id, sibling.request.id]);
    expect(batch.releaseTag).toMatch(/^oracle-batch-[0-9a-f]{12}$/u);

    const locator = await applyPreparedBatch({
      artifactDigest: `sha256:${'8'.repeat(64)}`,
      artifactId: 444,
      preparedDirectory: batchDirectory,
      repositoryRoot: fixture.repositoryRoot,
      workflowRunId: 555,
    });
    expect(locator.requestIds).toEqual([fixture.request.id, sibling.request.id]);
    expect((await readRepository(fixture.repositoryRoot)).records.size).toBe(2);

    const replay = await replayPreparedBatch({
      outputDirectory: join(workspace, 'batch-replay'),
      preparedDirectory: batchDirectory,
      previousPackDirectory: join(workspace, 'previous-packs'),
      repositoryRoot: fixture.repositoryRoot,
    });
    expect(replay).toEqual(batch);
  });

  it('refuses to materialize approvals that change the same oracle record', async () => {
    const fixture = await makeFixture('captured');
    const overlap = await makeSiblingFixture(fixture, 'shape-basic', 'shape-basic-webgl-second-2026-08-14');
    const preparedRoot = join(workspace, 'overlapping-approved-inputs');
    for (const [index, input] of [fixture, overlap].entries()) {
      const preparedDirectory = join(preparedRoot, input.request.id);
      await prepareFixture(input, preparedDirectory);
      await approvePreparedIntake({
        artifactDigest: `sha256:${String(index + 7).repeat(64)}`,
        artifactId: 300 + index,
        preparedDirectory,
        repositoryRoot: fixture.repositoryRoot,
        workflowRunId: 400 + index,
      });
    }

    await expect(
      prepareApprovedBatch({
        outputDirectory: join(workspace, 'overlapping-batch'),
        preparedRoot,
        previousPackDirectory: join(workspace, 'previous-packs'),
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).rejects.toThrow('approved candidates overlap oracles/functional/shape-basic/webgl.json');
  });

  it('refuses to apply a batch after its committed approval changes', async () => {
    const fixture = await makeFixture('captured');
    const preparedRoot = join(workspace, 'moved-approval-inputs');
    const preparedDirectory = join(preparedRoot, fixture.request.id);
    await prepareFixture(fixture, preparedDirectory);
    await approvePreparedIntake({
      artifactDigest: `sha256:${'9'.repeat(64)}`,
      artifactId: 222,
      preparedDirectory,
      repositoryRoot: fixture.repositoryRoot,
      workflowRunId: 333,
    });
    const batchDirectory = join(workspace, 'moved-approval-batch');
    await prepareApprovedBatch({
      outputDirectory: batchDirectory,
      preparedRoot,
      previousPackDirectory: join(workspace, 'previous-packs'),
      repositoryRoot: fixture.repositoryRoot,
    });
    const approvalPath = join(fixture.repositoryRoot, 'approvals', `${fixture.request.id}.json`);
    const approval = JSON.parse(await readFile(approvalPath, 'utf8')) as { preparedArtifact: { artifactId: number } };
    approval.preparedArtifact.artifactId += 1;
    await writeCanonicalJson(approvalPath, approval);

    await expect(
      applyPreparedBatch({
        artifactDigest: `sha256:${'8'.repeat(64)}`,
        artifactId: 444,
        preparedDirectory: batchDirectory,
        repositoryRoot: fixture.repositoryRoot,
        workflowRunId: 555,
      }),
    ).rejects.toThrow(`repository approval ${fixture.request.id} moved after batch preparation`);
  });

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
    const resizedImage = makePng(3, 2);
    await writeFile(join(fixture.candidateDirectory, 'images', 'functional', 'shape-basic', 'webgl.png'), resizedImage);
    const target = fixture.request.targets[0]!;
    fixture.requestImageDifferences.differences.push({
      capturedPixelSha256: hashBytes(Buffer.from(PNG.sync.read(resizedImage).data)),
      identity: { entry: target.entry, renderer: target.renderer, subject: fixture.request.subject },
      requestedPixelSha256: target.pixelSha256,
    });
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
    fixture.request.targets.push(fixture.request.targets[0]!);
    await writeRequestAndEnvelope(fixture);

    await expect(prepareFixture(fixture, join(workspace, 'overlapping'))).rejects.toThrow(
      'request overlaps target functional/shape-basic/webgl',
    );
  });

  it('accepts exact evidence when commissioned pixels differ from the reviewed request', async () => {
    const fixture = await makeFixture('captured');
    const target = fixture.request.targets[0]!;
    const capturedPixelSha256 = target.pixelSha256;
    target.pixelSha256 = '8'.repeat(64);
    fixture.requestImageDifferences.differences.push({
      capturedPixelSha256,
      identity: { entry: target.entry, renderer: target.renderer, subject: fixture.request.subject },
      requestedPixelSha256: target.pixelSha256,
    });
    await writeRequestAndEnvelope(fixture);

    const outputDirectory = join(workspace, 'pixel-difference');
    await prepareFixture(fixture, outputDirectory);

    await expect(readFile(join(outputDirectory, 'candidate', 'request-image-differences.json'), 'utf8')).resolves.toBe(
      canonicalJson(fixture.requestImageDifferences),
    );
  });

  it('rejects changed commissioned pixels without exact evidence', async () => {
    const fixture = await makeFixture('captured');
    fixture.request.targets[0]!.pixelSha256 = '8'.repeat(64);
    await writeRequestAndEnvelope(fixture);

    await expect(prepareFixture(fixture, join(workspace, 'missing-pixel-evidence'))).rejects.toThrow(
      'differ from the request without evidence',
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

  it('accepts Flight queue ordering timestamps without using them for freshness', async () => {
    const fixture = await makeFixture('captured');
    fixture.request.createdAt = '2000-01-01T00:00:00.000Z';
    await writeRequestAndEnvelope(fixture);

    await expect(prepareFixture(fixture, join(workspace, 'created-at'))).resolves.toBeDefined();
  });

  it('rejects a malformed Flight queue ordering timestamp', async () => {
    const fixture = await makeFixture('captured');
    fixture.request.createdAt = 'today';
    await writeRequestAndEnvelope(fixture);

    await expect(prepareFixture(fixture, join(workspace, 'invalid-created-at'))).rejects.toThrow(
      '/createdAt must match pattern',
    );
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
      reconcileFlight({
        flightRoot,
        oracleCommit: '8'.repeat(40),
        oracleRoot: fixture.repositoryRoot,
        requestIds: [fixture.request.id],
      }),
    ).rejects.toThrow('Flight request checksum is');
    await expect(
      readFile(join(flightRoot, 'reference-image-requests', `${fixture.request.id}.json`)),
    ).resolves.toBeDefined();
  });

  it('reconstructs fulfilled removals from current Flight bytes and retains changed historical requests', async () => {
    const fixture = await makeFixture('captured');
    await installFirstRelease(fixture, join(workspace, 'reconciled-request-prepared'));
    const flightRoot = join(workspace, 'reconciled-flight');
    const requestRoot = join(flightRoot, 'reference-image-requests');
    await mkdir(requestRoot, { recursive: true });
    await mkdir(join(flightRoot, 'scripts'), { recursive: true });
    await copyFile(fixture.requestPath, join(requestRoot, `${fixture.request.id}.json`));

    const exactHistoricalRequest = { ...fixture.request, id: 'historical-exact' };
    const changedHistoricalRequest = { ...fixture.request, id: 'historical-changed' };
    await writeCanonicalJson(join(requestRoot, 'historical-exact.json'), exactHistoricalRequest);
    await writeCanonicalJson(join(requestRoot, 'historical-changed.json'), {
      ...changedHistoricalRequest,
      reason: 'changed after its earlier release',
    });
    const manifestPath = join(fixture.repositoryRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as OracleManifest;
    manifest.sourceRequests.unshift(
      {
        flightCommit: '7'.repeat(40),
        id: exactHistoricalRequest.id,
        requestSha256: hashBytes(canonicalJson(exactHistoricalRequest)),
      },
      {
        flightCommit: '6'.repeat(40),
        id: changedHistoricalRequest.id,
        requestSha256: hashBytes(canonicalJson(changedHistoricalRequest)),
      },
    );
    await writeCanonicalJson(manifestPath, manifest);

    const result = await reconcileFlight({
      flightRoot,
      oracleCommit: '8'.repeat(40),
      oracleRoot: fixture.repositoryRoot,
      requestIds: [fixture.request.id],
    });

    expect(result.removedRequestIds).toEqual(['historical-exact', fixture.request.id]);
    expect(result.retainedChangedRequestIds).toEqual(['historical-changed']);
    await expect(readFile(join(requestRoot, 'historical-exact.json'))).rejects.toThrow();
    await expect(readFile(join(requestRoot, `${fixture.request.id}.json`))).rejects.toThrow();
    await expect(readFile(join(requestRoot, 'historical-changed.json'))).resolves.toBeDefined();
  });
});

interface Fixture {
  candidate: CandidateManifest;
  candidateDirectory: string;
  envelope: DispatchEnvelope;
  envelopePath: string;
  repositoryRoot: string;
  request: FlightOracleRequest;
  requestImageDifferences: RequestImageDifferences;
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

  const imageBytes = makePng();
  const reviewedPixelSha256 = hashBytes(Buffer.from(PNG.sync.read(imageBytes).data));
  const request: FlightOracleRequest = {
    frames: 1,
    id: 'shape-basic-webgl-2026-08-14',
    reason: 'add the first reference',
    schemaVersion: 3,
    subject: 'functional',
    targets: [
      {
        build: { commit: 'a'.repeat(40), dirty: [], dirtyOmitted: 0 },
        capture: { environmentId, hostInstanceId: 'test-host' },
        entry: 'shape-basic',
        pixelSha256: reviewedPixelSha256,
        renderer: 'webgl',
      },
    ],
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
  const requestImageDifferences: RequestImageDifferences = {
    differences: [],
    requestId: request.id,
    schemaVersion: 1,
  };
  await writeCanonicalJson(join(candidateDirectory, 'request-image-differences.json'), requestImageDifferences);
  if (status === 'captured') {
    const image = join(candidateDirectory, 'images', 'functional', 'shape-basic', 'webgl.png');
    await mkdir(join(image, '..'), { recursive: true });
    await writeFile(image, imageBytes);
  }
  return {
    candidate,
    candidateDirectory,
    envelope,
    envelopePath,
    repositoryRoot,
    request,
    requestImageDifferences,
    requestPath,
  };
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

async function makeSiblingFixture(
  fixture: Readonly<Fixture>,
  entry = 'shape-secondary',
  requestId = 'shape-secondary-webgl-2026-08-14',
): Promise<Fixture> {
  const request = structuredClone(fixture.request);
  request.id = requestId;
  request.reason = 'add a disjoint reference';
  request.targets[0]!.entry = entry;
  const requestPath = join(workspace, 'request-sibling.json');
  await writeCanonicalJson(requestPath, request);

  const candidate = structuredClone(fixture.candidate);
  candidate.requestId = request.id;
  candidate.captures[0]!.identity.entry = entry;
  candidate.captures[0]!.file = `images/functional/${entry}/webgl.png`;
  const candidateDirectory = join(workspace, 'candidate-sibling');
  const image = join(candidateDirectory, candidate.captures[0]!.file!);
  await mkdir(join(image, '..'), { recursive: true });
  await writeCanonicalJson(join(candidateDirectory, 'candidate.json'), candidate);
  await writeCanonicalJson(join(candidateDirectory, 'request-image-differences.json'), {
    differences: [],
    requestId: request.id,
    schemaVersion: 1,
  } satisfies RequestImageDifferences);
  await copyFile(join(fixture.candidateDirectory, 'images', 'functional', 'shape-basic', 'webgl.png'), image);

  const envelope = structuredClone(fixture.envelope);
  envelope.artifactId += 1;
  envelope.requestPath = `reference-image-requests/${request.id}.json`;
  envelope.requestSha256 = await hashFile(requestPath);
  envelope.workflowRunId += 1;
  const envelopePath = join(workspace, 'envelope-sibling.json');
  await writeCanonicalJson(envelopePath, envelope);
  return {
    candidate,
    candidateDirectory,
    envelope,
    envelopePath,
    repositoryRoot: fixture.repositoryRoot,
    request,
    requestImageDifferences: { differences: [], requestId: request.id, schemaVersion: 1 },
    requestPath,
  };
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
  fixture.requestImageDifferences.requestId = fixture.request.id;
  await writeCanonicalJson(
    join(fixture.candidateDirectory, 'request-image-differences.json'),
    fixture.requestImageDifferences,
  );
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
