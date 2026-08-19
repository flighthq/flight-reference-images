import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { canonicalJson, errorMessage, hashBytes, hashFile, readJson, writeCanonicalJson } from './json.js';
import { buildReleasePacks, extractVerifiedReleasePacks, verifyReleasePacks } from './pack.js';
import {
  findFiles,
  findNonRegularEntries,
  identityKey,
  imagePath,
  oracleRecordPath,
  resolveInside,
  resolvePack,
} from './paths.js';
import { comparePngs, createDeltaPng, DimensionMismatchError, evaluateMismatch, readPng } from './png.js';
import { readRepository } from './repository.js';
import { writeReviewReport, type ReviewRow } from './report.js';
import { assertSchema } from './schemas.js';
import type { SchemaName } from './schemas.js';
import type {
  ArtifactLocator,
  BatchLocator,
  CandidateLocator,
  CandidateApproval,
  CandidateManifest,
  ComparisonPolicy,
  DispatchEnvelope,
  EnvironmentDescriptor,
  FlightOracleRequest,
  IntakePolicy,
  OracleManifest,
  OracleRecord,
  PackConfiguration,
  PreparedIntake,
  PreparedBatch,
  RequestImageDifferences,
} from './types.js';

const REQUEST_IMAGE_DIFFERENCES_FILE = 'request-image-differences.json';

export interface ApplyIntakeOptions {
  artifactDigest: string;
  artifactId: number;
  preparedDirectory: string;
  repositoryRoot: string;
  workflowRunId: number;
}

export interface ApproveIntakeOptions {
  artifactDigest: string;
  artifactId: number;
  preparedDirectory: string;
  repositoryRoot: string;
  workflowRunId: number;
}

export interface PrepareIntakeOptions {
  candidateDirectory: string;
  envelopePath: string;
  outputDirectory: string;
  previousPackDirectory: string;
  repositoryRoot: string;
  requestPath: string;
}

export interface ReplayIntakeOptions {
  outputDirectory: string;
  preparedDirectory: string;
  previousPackDirectory: string;
  repositoryRoot: string;
}

export interface PrepareBatchOptions {
  outputDirectory: string;
  preparedRoot: string;
  previousPackDirectory: string;
  repositoryRoot: string;
}

export interface ApplyBatchOptions {
  artifactDigest: string;
  artifactId: number;
  preparedDirectory: string;
  repositoryRoot: string;
  workflowRunId: number;
}

interface IntakeBase {
  environments: ReadonlyMap<string, EnvironmentDescriptor>;
  intakePolicy: IntakePolicy;
  manifest: OracleManifest;
  packConfiguration: PackConfiguration;
  policies: ReadonlyMap<string, ComparisonPolicy>;
  records: ReadonlyMap<string, OracleRecord>;
}

interface ProduceIntakeOptions extends PrepareIntakeOptions {
  enforceRequestAge: boolean;
}

export async function approvePreparedIntake(options: Readonly<ApproveIntakeOptions>): Promise<CandidateApproval> {
  const preparedDirectory = resolve(options.preparedDirectory);
  const repositoryRoot = resolve(options.repositoryRoot);
  const prepared = await readPreparedIntake(preparedDirectory);
  await validatePreparedIntakeFiles(preparedDirectory, prepared, false);
  const request = await readTyped<FlightOracleRequest>(join(preparedDirectory, 'request.json'), 'request');
  const envelope = await readTyped<DispatchEnvelope>(join(preparedDirectory, 'envelope.json'), 'dispatch-envelope');
  const baseRecords = await readOracleRecords(join(preparedDirectory, 'base'));
  const expectedPaths = prepared.records.map((record) => record.path).sort();
  const targetPaths = request.targets
    .map((target) => oracleRecordPath({ entry: target.entry, renderer: target.renderer, subject: request.subject }))
    .sort();
  if (canonicalJson(expectedPaths) !== canonicalJson(targetPaths)) {
    throw new Error('prepared record paths differ from the approved request targets');
  }

  const preparedArtifact: ArtifactLocator = {
    artifactId: options.artifactId,
    digest: options.artifactDigest,
    repository: 'flighthq/flight-reference-images',
    workflowRunId: options.workflowRunId,
  };
  const approval: CandidateApproval = {
    $schema: '../schemas/approval.schema.json',
    baseRecords: expectedPaths.map((path) => {
      const record = baseRecords.get(path);
      return { path, sha256: record === undefined ? null : hashBytes(canonicalJson(record)) };
    }),
    candidateSha256: prepared.candidateSha256,
    flightCommit: envelope.flightCommit,
    preparedArtifact,
    records: [...prepared.records].sort((left, right) => left.path.localeCompare(right.path)),
    requestId: request.id,
    requestSha256: prepared.requestSha256,
    schemaVersion: 1,
    sourceArtifact: {
      artifactId: envelope.artifactId,
      digest: envelope.artifactDigest,
      repository: envelope.repository,
      workflowRunId: envelope.workflowRunId,
    },
  };
  assertSchema<CandidateApproval>('approval', approval);
  await verifyPreparedApproval(approval, preparedDirectory);
  await mkdir(join(repositoryRoot, 'approvals'), { recursive: true });
  await writeCanonicalJson(join(repositoryRoot, 'approvals', `${request.id}.json`), approval);
  return approval;
}

export async function verifyPreparedApproval(
  approval: Readonly<CandidateApproval>,
  preparedDirectory: string,
): Promise<void> {
  const directory = resolve(preparedDirectory);
  const prepared = await readPreparedIntake(directory);
  await validatePreparedIntakeFiles(directory, prepared, false);
  const request = await readTyped<FlightOracleRequest>(join(directory, 'request.json'), 'request');
  const envelope = await readTyped<DispatchEnvelope>(join(directory, 'envelope.json'), 'dispatch-envelope');
  if (approval.requestId !== request.id) throw new Error('approval request id differs from prepared request');
  if (approval.requestSha256 !== prepared.requestSha256)
    throw new Error('approval request hash differs from prepared intake');
  if (approval.candidateSha256 !== prepared.candidateSha256)
    throw new Error('approval candidate hash differs from prepared intake');
  if (approval.flightCommit !== envelope.flightCommit) throw new Error('approval Flight commit differs from envelope');
  if (
    canonicalJson(approval.records) !==
    canonicalJson([...prepared.records].sort((a, b) => a.path.localeCompare(b.path)))
  ) {
    throw new Error('approval record hashes differ from prepared intake');
  }
  const sourceArtifact: ArtifactLocator = {
    artifactId: envelope.artifactId,
    digest: envelope.artifactDigest,
    repository: envelope.repository,
    workflowRunId: envelope.workflowRunId,
  };
  if (canonicalJson(approval.sourceArtifact) !== canonicalJson(sourceArtifact))
    throw new Error('approval source artifact differs from envelope');
  const baseRecords = await readOracleRecords(join(directory, 'base'));
  const expectedBase = approval.records.map(({ path }) => {
    const record = baseRecords.get(path);
    return { path, sha256: record === undefined ? null : hashBytes(canonicalJson(record)) };
  });
  if (canonicalJson(approval.baseRecords) !== canonicalJson(expectedBase))
    throw new Error('approval base record hashes differ from prepared intake');
}

export async function applyPreparedIntake(options: Readonly<ApplyIntakeOptions>): Promise<CandidateLocator> {
  const preparedDirectory = resolve(options.preparedDirectory);
  const repositoryRoot = resolve(options.repositoryRoot);
  const prepared = await readPreparedIntake(preparedDirectory);
  await validatePreparedIntakeFiles(preparedDirectory, prepared);

  const base = await readRepository(repositoryRoot);
  if (hashBytes(canonicalJson(base.manifest)) !== prepared.baseManifestSha256) {
    throw new Error('repository manifest moved after candidate preparation');
  }
  if (hashRecordMap(base.records) !== prepared.baseRecordsSha256) {
    throw new Error('repository oracle records moved after candidate preparation');
  }

  const expectedRoot = join(preparedDirectory, 'expected');
  await copyFile(join(expectedRoot, 'manifest.json'), join(repositoryRoot, 'manifest.json'));
  for (const record of prepared.records) {
    const source = resolveInside(expectedRoot, record.path);
    const destination = resolveInside(repositoryRoot, record.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  for (const path of await findFiles(join(repositoryRoot, 'candidates'), '.json')) {
    await unlink(resolveInside(join(repositoryRoot, 'candidates'), path));
  }

  const envelope = await readTyped<DispatchEnvelope>(join(preparedDirectory, 'envelope.json'), 'dispatch-envelope');
  const request = await readTyped<FlightOracleRequest>(join(preparedDirectory, 'request.json'), 'request');
  const manifest = await readTyped<OracleManifest>(join(expectedRoot, 'manifest.json'), 'manifest');
  const locator: CandidateLocator = {
    $schema: '../schemas/candidate-locator.schema.json',
    manifestSha256: prepared.expectedManifestSha256,
    preparedArtifact: {
      artifactId: options.artifactId,
      digest: options.artifactDigest,
      repository: 'flighthq/flight-reference-images',
      workflowRunId: options.workflowRunId,
    },
    releaseTag: prepared.releaseTag,
    requestId: request.id,
    schemaVersion: 1,
    sourceArtifact: {
      artifactId: envelope.artifactId,
      digest: envelope.artifactDigest,
      repository: envelope.repository,
      workflowRunId: envelope.workflowRunId,
    },
  };
  assertSchema<CandidateLocator>('candidate-locator', locator);
  if (manifest.releaseTag !== locator.releaseTag)
    throw new Error('prepared manifest and candidate locator release tags differ');
  await writeCanonicalJson(join(repositoryRoot, 'candidates', `${request.id}.json`), locator);
  await readRepository(repositoryRoot);
  return locator;
}

export async function prepareIntake(options: Readonly<PrepareIntakeOptions>): Promise<PreparedIntake> {
  const repository = await readRepository(resolve(options.repositoryRoot));
  return produceIntake(
    {
      environments: repository.environments,
      intakePolicy: repository.intakePolicy,
      manifest: repository.manifest,
      packConfiguration: repository.packConfiguration,
      policies: repository.policies,
      records: repository.records,
    },
    { ...options, enforceRequestAge: true },
  );
}

export async function replayPreparedIntake(options: Readonly<ReplayIntakeOptions>): Promise<PreparedIntake> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const preparedDirectory = resolve(options.preparedDirectory);
  const committed = await readRepository(repositoryRoot);
  const baseManifest = await readTyped<OracleManifest>(join(preparedDirectory, 'base', 'manifest.json'), 'manifest');
  const baseRecords = await readOracleRecords(join(preparedDirectory, 'base'));
  const replayed = await produceIntake(
    {
      environments: committed.environments,
      intakePolicy: committed.intakePolicy,
      manifest: baseManifest,
      packConfiguration: committed.packConfiguration,
      policies: committed.policies,
      records: baseRecords,
    },
    {
      candidateDirectory: join(preparedDirectory, 'candidate'),
      envelopePath: join(preparedDirectory, 'envelope.json'),
      outputDirectory: options.outputDirectory,
      previousPackDirectory: options.previousPackDirectory,
      repositoryRoot,
      requestPath: join(preparedDirectory, 'request.json'),
      enforceRequestAge: false,
    },
  );

  const original = await readPreparedIntake(preparedDirectory);
  if (canonicalJson(replayed) !== canonicalJson(original))
    throw new Error('replayed intake descriptor differs from reviewed artifact');
  const replayExpected = join(resolve(options.outputDirectory), 'expected');
  if ((await readFile(join(replayExpected, 'manifest.json'), 'utf8')) !== canonicalJson(committed.manifest)) {
    throw new Error('replayed manifest differs from the committed manifest');
  }
  for (const record of replayed.records) {
    const committedRecord = committed.records.get(record.path);
    if (committedRecord === undefined) throw new Error(`committed repository is missing ${record.path}`);
    if ((await readFile(resolveInside(replayExpected, record.path), 'utf8')) !== canonicalJson(committedRecord)) {
      throw new Error(`replayed ${record.path} differs from the committed record`);
    }
  }
  await verifyReleasePacks(
    committed.manifest,
    committed.records,
    join(resolve(options.outputDirectory), 'prospective-packs'),
  );
  return replayed;
}

export async function prepareApprovedBatch(options: Readonly<PrepareBatchOptions>): Promise<PreparedBatch> {
  const repository = await readRepository(resolve(options.repositoryRoot));
  const released = new Set(repository.manifest.sourceRequests.map((request) => request.id));
  const approvals = [...repository.approvals.values()]
    .filter((approval) => !released.has(approval.requestId))
    .sort((left, right) => left.requestId.localeCompare(right.requestId));
  if (approvals.length === 0) throw new Error('there are no approved candidates awaiting release');
  return produceApprovedBatch(
    {
      environments: repository.environments,
      intakePolicy: repository.intakePolicy,
      manifest: repository.manifest,
      packConfiguration: repository.packConfiguration,
      policies: repository.policies,
      records: repository.records,
    },
    approvals.map((approval) => ({
      approval,
      directory: join(resolve(options.preparedRoot), approval.requestId),
      fullyPrepared: true,
    })),
    options,
  );
}

export async function applyPreparedBatch(options: Readonly<ApplyBatchOptions>): Promise<BatchLocator> {
  const preparedDirectory = resolve(options.preparedDirectory);
  const repositoryRoot = resolve(options.repositoryRoot);
  const prepared = await readPreparedBatch(preparedDirectory);
  await validatePreparedBatchFiles(preparedDirectory, prepared);
  const base = await readRepository(repositoryRoot);
  if (hashBytes(canonicalJson(base.manifest)) !== prepared.baseManifestSha256)
    throw new Error('repository manifest moved after batch preparation');
  if (hashRecordMap(base.records) !== prepared.baseRecordsSha256)
    throw new Error('repository oracle records moved after batch preparation');
  const released = new Set(base.manifest.sourceRequests.map((request) => request.id));
  const pendingRequestIds = [...base.approvals.values()]
    .filter((approval) => !released.has(approval.requestId))
    .map((approval) => approval.requestId)
    .sort();
  if (canonicalJson(pendingRequestIds) !== canonicalJson(prepared.requestIds))
    throw new Error('repository pending approval set moved after batch preparation');
  for (const expected of prepared.approvalSha256s) {
    const approval = base.approvals.get(`approvals/${expected.requestId}.json`);
    if (approval === undefined || hashBytes(canonicalJson(approval)) !== expected.sha256)
      throw new Error(`repository approval ${expected.requestId} moved after batch preparation`);
  }

  const expected = join(preparedDirectory, 'expected');
  await copyFile(join(expected, 'manifest.json'), join(repositoryRoot, 'manifest.json'));
  for (const record of prepared.records) {
    const destination = resolveInside(repositoryRoot, record.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolveInside(expected, record.path), destination);
  }
  for (const path of await findFiles(join(repositoryRoot, 'candidates'), '.json'))
    await unlink(resolveInside(join(repositoryRoot, 'candidates'), path));
  const locator: BatchLocator = {
    $schema: '../schemas/candidate-locator.schema.json',
    manifestSha256: prepared.expectedManifestSha256,
    preparedArtifact: {
      artifactId: options.artifactId,
      digest: options.artifactDigest,
      repository: 'flighthq/flight-reference-images',
      workflowRunId: options.workflowRunId,
    },
    releaseTag: prepared.releaseTag,
    requestIds: prepared.requestIds,
    schemaVersion: 2,
  };
  assertSchema<BatchLocator>('candidate-locator', locator);
  await writeCanonicalJson(join(repositoryRoot, 'candidates', `${prepared.releaseTag}.json`), locator);
  await readRepository(repositoryRoot);
  return locator;
}

export async function replayPreparedBatch(options: Readonly<ReplayIntakeOptions>): Promise<PreparedBatch> {
  const preparedDirectory = resolve(options.preparedDirectory);
  const committed = await readRepository(resolve(options.repositoryRoot));
  const baseManifest = await readTyped<OracleManifest>(join(preparedDirectory, 'base', 'manifest.json'), 'manifest');
  const baseRecords = await readOracleRecords(join(preparedDirectory, 'base'));
  const original = await readPreparedBatch(preparedDirectory);
  const approvals = await Promise.all(
    original.requestIds.map(async (requestId) => ({
      approval: await readTyped<CandidateApproval>(
        join(preparedDirectory, 'inputs', requestId, 'approval.json'),
        'approval',
      ),
      directory: join(preparedDirectory, 'inputs', requestId),
      fullyPrepared: false,
    })),
  );
  const replayed = await produceApprovedBatch(
    {
      environments: committed.environments,
      intakePolicy: committed.intakePolicy,
      manifest: baseManifest,
      packConfiguration: committed.packConfiguration,
      policies: committed.policies,
      records: baseRecords,
    },
    approvals,
    options,
  );
  if (canonicalJson(replayed) !== canonicalJson(original)) throw new Error('replayed batch descriptor differs');
  const output = resolve(options.outputDirectory);
  if ((await readFile(join(output, 'expected', 'manifest.json'), 'utf8')) !== canonicalJson(committed.manifest))
    throw new Error('replayed batch manifest differs from committed manifest');
  for (const record of replayed.records) {
    const committedRecord = committed.records.get(record.path);
    if (committedRecord === undefined) throw new Error(`committed repository is missing ${record.path}`);
    if (
      (await readFile(resolveInside(join(output, 'expected'), record.path), 'utf8')) !== canonicalJson(committedRecord)
    )
      throw new Error(`replayed batch ${record.path} differs from committed record`);
  }
  await verifyReleasePacks(committed.manifest, committed.records, join(output, 'prospective-packs'));
  return replayed;
}

interface BatchInput {
  approval: CandidateApproval;
  directory: string;
  fullyPrepared: boolean;
}

type ProduceBatchOptions = Pick<PrepareBatchOptions, 'outputDirectory' | 'previousPackDirectory' | 'repositoryRoot'>;

async function produceApprovedBatch(
  originalBase: Readonly<IntakeBase>,
  inputs: readonly BatchInput[],
  options: Readonly<ProduceBatchOptions>,
): Promise<PreparedBatch> {
  const outputDirectory = resolve(options.outputDirectory);
  await createNewDirectory(outputDirectory);
  const workspace = await mkdtemp(join(tmpdir(), 'flight-reference-images-batch-'));
  try {
    const requestIds = inputs.map((input) => input.approval.requestId);
    if (new Set(requestIds).size !== requestIds.length) throw new Error('approved batch repeats a request');
    if (canonicalJson(requestIds) !== canonicalJson([...requestIds].sort()))
      throw new Error('approved batch inputs must be sorted by request id');
    const baseManifestSha256 = hashBytes(canonicalJson(originalBase.manifest));
    const baseRecordsSha256 = hashRecordMap(originalBase.records);
    const touched = new Set<string>();
    const changedRecords = new Map<string, OracleRecord>();
    const changedSources = new Map<string, string>();
    const approvalSha256s: PreparedBatch['approvalSha256s'] = [];
    const recordsByPath = new Map(originalBase.records);
    const sourceRequests = [...originalBase.manifest.sourceRequests];
    const released = new Set(sourceRequests.map((request) => request.id));

    for (const input of inputs) {
      const { approval } = input;
      if (input.fullyPrepared) await verifyPreparedApproval(approval, input.directory);
      else await verifyMinimalApprovalInput(approval, input.directory);
      if (released.has(approval.requestId)) throw new Error(`request ${approval.requestId} was already released`);
      for (const expected of approval.baseRecords) {
        if (touched.has(expected.path)) throw new Error(`approved candidates overlap ${expected.path}`);
        const record = originalBase.records.get(expected.path);
        const actual = record === undefined ? null : hashBytes(canonicalJson(record));
        if (actual !== expected.sha256)
          throw new Error(`${approval.requestId} was reviewed against stale ${expected.path}`);
        touched.add(expected.path);
      }
      const candidate = await readTyped<CandidateManifest>(
        join(input.directory, 'candidate', 'candidate.json'),
        'candidate',
      );
      const captures = new Map(
        candidate.captures.map((capture) => [oracleRecordPath(capture.identity), capture] as const),
      );
      for (const approved of approval.records) {
        const value = await readTyped<OracleRecord>(
          resolveInside(join(input.directory, 'expected'), approved.path),
          'oracle-record',
        );
        if (hashBytes(canonicalJson(value)) !== approved.sha256)
          throw new Error(`${approval.requestId} approved record ${approved.path} checksum differs`);
        if (oracleRecordPath(value.identity) !== approved.path)
          throw new Error(`${approval.requestId} approved record identity differs from ${approved.path}`);
        if (
          value.environmentId !== candidate.environmentId ||
          value.comparisonPolicyId !== candidate.comparisonPolicyId
        )
          throw new Error(`${approval.requestId} approved record policy binding differs from its candidate`);
        const environment = originalBase.environments.get(`environments/${value.environmentId}.json`);
        const policy = originalBase.policies.get(`comparison-policies/${value.comparisonPolicyId}.json`);
        if (environment === undefined || policy === undefined || policy.environmentId !== value.environmentId)
          throw new Error(`${approval.requestId} approved record names unavailable calibration metadata`);
        if (resolvePack(value.identity, originalBase.packConfiguration) !== value.pack)
          throw new Error(`${approval.requestId} approved record pack routing is stale`);
        const capture = captures.get(approved.path);
        if (capture?.status !== 'captured' || capture.file === undefined)
          throw new Error(`${approval.requestId} has no captured image for ${approved.path}`);
        recordsByPath.set(approved.path, value);
        changedRecords.set(approved.path, value);
        changedSources.set(approved.path, resolveInside(join(input.directory, 'candidate'), capture.file));
      }
      sourceRequests.push({
        flightCommit: approval.flightCommit,
        id: approval.requestId,
        requestSha256: approval.requestSha256,
      });
      released.add(approval.requestId);
      approvalSha256s.push({ requestId: approval.requestId, sha256: hashBytes(canonicalJson(approval)) });

      const staged = join(outputDirectory, 'inputs', approval.requestId);
      await mkdir(staged, { recursive: true });
      await cp(join(input.directory, 'candidate'), join(staged, 'candidate'), { recursive: true });
      await copyFile(join(input.directory, 'request.json'), join(staged, 'request.json'));
      await copyFile(join(input.directory, 'envelope.json'), join(staged, 'envelope.json'));
      await writeCanonicalJson(join(staged, 'approval.json'), approval);
      for (const approved of approval.records) {
        const destination = resolveInside(join(staged, 'expected'), approved.path);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(resolveInside(join(input.directory, 'expected'), approved.path), destination);
      }
    }

    const previousImages = join(workspace, 'previous-images');
    await extractVerifiedReleasePacks(originalBase.manifest, resolve(options.previousPackDirectory), previousImages);
    const releaseTag = `oracle-batch-${hashBytes(canonicalJson({ approvalSha256s, baseManifestSha256, baseRecordsSha256 })).slice(0, 12)}`;
    const sources = [...recordsByPath.entries()].map(([path, record]) => ({
      path: changedSources.get(path) ?? join(previousImages, record.pack, imagePath(record.identity)),
      record,
    }));
    const packs = await buildReleasePacks(sources, releaseTag, join(outputDirectory, 'prospective-packs'));
    const manifest: OracleManifest = {
      $schema: './schemas/manifest.schema.json',
      packs,
      parentReleaseTag: originalBase.manifest.releaseTag,
      releaseTag,
      schemaVersion: 1,
      sourceRequests,
    };
    assertSchema<OracleManifest>('manifest', manifest);
    const expected = join(outputDirectory, 'expected');
    await mkdir(expected, { recursive: true });
    await writeCanonicalJson(join(expected, 'manifest.json'), manifest);
    const records: PreparedBatch['records'] = [];
    for (const [path, record] of [...changedRecords].sort(([left], [right]) => left.localeCompare(right))) {
      const destination = resolveInside(expected, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeCanonicalJson(destination, record);
      records.push({ path, sha256: hashBytes(canonicalJson(record)) });
    }
    await stageBatchBase(outputDirectory, originalBase);
    const prepared: PreparedBatch = {
      approvalSha256s,
      baseManifestSha256,
      baseRecordsSha256,
      expectedManifestSha256: hashBytes(canonicalJson(manifest)),
      packs,
      records,
      releaseTag,
      requestIds,
      schemaVersion: 1,
    };
    assertSchema<PreparedBatch>('prepared-batch', prepared);
    await writeCanonicalJson(join(outputDirectory, 'prepared-batch.json'), prepared);
    return prepared;
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

async function produceIntake(
  base: Readonly<IntakeBase>,
  options: Readonly<ProduceIntakeOptions>,
): Promise<PreparedIntake> {
  const candidateDirectory = resolve(options.candidateDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  await createNewDirectory(outputDirectory);

  const workspace = await mkdtemp(join(tmpdir(), 'flight-reference-images-intake-'));
  try {
    const nonRegularEntries = await findNonRegularEntries(candidateDirectory);
    if (nonRegularEntries.length > 0) {
      throw new Error(`candidate bundle contains non-regular entry ${nonRegularEntries[0]}`);
    }
    const candidate = await readTyped<CandidateManifest>(join(candidateDirectory, 'candidate.json'), 'candidate');
    const requestImageDifferences = await readTyped<RequestImageDifferences>(
      join(candidateDirectory, REQUEST_IMAGE_DIFFERENCES_FILE),
      'request-image-differences',
    );
    const envelope = await readTyped<DispatchEnvelope>(resolve(options.envelopePath), 'dispatch-envelope');
    const request = await readTyped<FlightOracleRequest>(resolve(options.requestPath), 'request');
    const requestBindings = await validateBindings(
      base,
      candidateDirectory,
      candidate,
      envelope,
      request,
      requestImageDifferences,
      options.requestPath,
      options.enforceRequestAge,
    );
    await stageInputs(outputDirectory, candidateDirectory, candidate, envelope, options.requestPath, base);

    const previousImages = join(workspace, 'previous');
    await extractVerifiedReleasePacks(base.manifest, resolve(options.previousPackDirectory), previousImages);
    const policy = findPolicy(base.policies, candidate.comparisonPolicyId);
    const rows: ReviewRow[] = [];
    const candidateSources = new Map<string, string>();
    const replacementRecords = new Map<string, OracleRecord>();
    const missing: string[] = [];

    for (const capture of candidate.captures) {
      const key = identityKey(capture.identity);
      if (capture.status === 'missing') {
        rows.push({
          assets: {},
          identity: capture.identity,
          note: capture.error ?? 'capture failed without a diagnostic',
          status: 'missing',
        });
        missing.push(key);
        continue;
      }
      if (capture.file === undefined || capture.provenance === undefined)
        throw new Error(`${key} captured row is incomplete`);
      const sourcePath = resolveInside(candidateDirectory, capture.file);
      const decoded = await readPng(sourcePath, {
        maximumBytes: base.intakePolicy.maximumImageBytes,
        maximumHeight: base.intakePolicy.maximumImageHeight,
        maximumPixels: base.intakePolicy.maximumImagePixels,
        maximumWidth: base.intakePolicy.maximumImageWidth,
      });
      assertRequestedPixelEvidence(key, decoded.pixelSha256, requestBindings);
      const recordPath = oracleRecordPath(capture.identity);
      const previousRecord = base.records.get(recordPath);
      const pack = resolvePack(capture.identity, base.packConfiguration);
      const record: OracleRecord = {
        $schema: '../../../schemas/oracle-record.schema.json',
        artifactSha256: decoded.artifactSha256,
        colorSpace: 'srgb',
        comparisonPolicyId: candidate.comparisonPolicyId,
        environmentId: candidate.environmentId,
        flightCommit: envelope.flightCommit,
        height: decoded.height,
        identity: capture.identity,
        pack,
        pixelFormat: 'rgba8',
        pixelSha256: decoded.pixelSha256,
        provenance: capture.provenance,
        request: { id: request.id, sha256: envelope.requestSha256 },
        schemaVersion: 1,
        width: decoded.width,
      };
      assertSchema<OracleRecord>('oracle-record', record, recordPath);
      replacementRecords.set(recordPath, record);
      candidateSources.set(recordPath, sourcePath);
      rows.push(
        await createReviewRow(
          outputDirectory,
          capture.identity,
          sourcePath,
          decoded,
          previousRecord,
          previousImages,
          policy,
        ),
      );
    }

    await writeReviewReport(rows, join(outputDirectory, 'report'));
    if (missing.length > 0) throw new Error(`requested captures are missing: ${missing.sort().join(', ')}`);

    const newRecords = new Map(base.records);
    for (const [path, record] of replacementRecords) newRecords.set(path, record);
    const releaseHash = hashBytes(
      `${envelope.flightCommit}\n${envelope.requestSha256}\n${await hashCandidate(candidateDirectory, candidate)}\n`,
    );
    const releaseTag = `oracle-${request.id}-${releaseHash.slice(0, 12)}`;
    const sources = [];
    for (const [path, record] of newRecords) {
      const candidateSource = candidateSources.get(path);
      sources.push({
        path: candidateSource ?? join(previousImages, record.pack, imagePath(record.identity)),
        record,
      });
    }
    const packs = await buildReleasePacks(sources, releaseTag, join(outputDirectory, 'prospective-packs'));
    const manifest: OracleManifest = {
      $schema: './schemas/manifest.schema.json',
      packs,
      parentReleaseTag: base.manifest.releaseTag,
      releaseTag,
      schemaVersion: 1,
      sourceRequests: [
        ...base.manifest.sourceRequests,
        { flightCommit: envelope.flightCommit, id: request.id, requestSha256: envelope.requestSha256 },
      ],
    };
    assertSchema<OracleManifest>('manifest', manifest);

    const expectedRoot = join(outputDirectory, 'expected');
    await mkdir(expectedRoot, { recursive: true });
    await writeCanonicalJson(join(expectedRoot, 'manifest.json'), manifest);
    const preparedRecords: PreparedIntake['records'] = [];
    for (const [path, record] of [...replacementRecords].sort(([left], [right]) => left.localeCompare(right))) {
      const destination = resolveInside(expectedRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeCanonicalJson(destination, record);
      preparedRecords.push({ path, sha256: hashBytes(canonicalJson(record)) });
    }

    const prepared: PreparedIntake = {
      baseManifestSha256: hashBytes(canonicalJson(base.manifest)),
      baseRecordsSha256: hashRecordMap(base.records),
      candidateSha256: await hashCandidate(candidateDirectory, candidate),
      envelopeSha256: hashBytes(canonicalJson(envelope)),
      expectedManifestSha256: hashBytes(canonicalJson(manifest)),
      packs,
      records: preparedRecords,
      releaseTag,
      requestSha256: envelope.requestSha256,
      schemaVersion: 1,
    };
    assertSchema<PreparedIntake>('prepared-intake', prepared);
    await writeCanonicalJson(join(outputDirectory, 'prepared-intake.json'), prepared);
    return prepared;
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

async function createReviewRow(
  outputDirectory: string,
  identity: OracleRecord['identity'],
  sourcePath: string,
  decoded: Awaited<ReturnType<typeof readPng>>,
  previousRecord: OracleRecord | undefined,
  previousImages: string,
  policy: Readonly<ComparisonPolicy>,
): Promise<ReviewRow> {
  const assetDirectory = join(outputDirectory, 'report', 'images', identityKey(identity));
  await mkdir(assetDirectory, { recursive: true });
  await copyFile(sourcePath, join(assetDirectory, 'new.png'));
  const assets: ReviewRow['assets'] = { new: `images/${identityKey(identity)}/new.png` };
  if (previousRecord === undefined) return { assets, identity, note: 'no prior reference', status: 'added' };

  const previousPath = join(previousImages, previousRecord.pack, imagePath(identity));
  const previous = await readPng(previousPath);
  assertPreviousImage(previousPath, previous, previousRecord);
  await copyFile(previousPath, join(assetDirectory, 'old.png'));
  assets.old = `images/${identityKey(identity)}/old.png`;
  try {
    const mismatch = comparePngs(previous, decoded, policy.channelTolerance);
    await writeFile(join(assetDirectory, 'delta.png'), createDeltaPng(previous, decoded));
    assets.delta = `images/${identityKey(identity)}/delta.png`;
    return {
      assets,
      identity,
      mismatch,
      status: mismatch.mismatchedPixels === 0 ? 'unchanged' : 'changed',
      withinPolicy: evaluateMismatch(mismatch, policy),
    };
  } catch (error) {
    if (!(error instanceof DimensionMismatchError)) throw error;
    return { assets, identity, note: error.message, status: 'dimension-changed' };
  }
}

async function stageInputs(
  outputDirectory: string,
  candidateDirectory: string,
  candidate: Readonly<CandidateManifest>,
  envelope: Readonly<DispatchEnvelope>,
  requestPath: string,
  base: Readonly<IntakeBase>,
): Promise<void> {
  const stagedCandidate = join(outputDirectory, 'candidate');
  await mkdir(stagedCandidate, { recursive: true });
  await copyFile(join(candidateDirectory, 'candidate.json'), join(stagedCandidate, 'candidate.json'));
  await copyFile(
    join(candidateDirectory, REQUEST_IMAGE_DIFFERENCES_FILE),
    join(stagedCandidate, REQUEST_IMAGE_DIFFERENCES_FILE),
  );
  for (const capture of candidate.captures) {
    if (capture.status !== 'captured' || capture.file === undefined) continue;
    const destination = resolveInside(stagedCandidate, capture.file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolveInside(candidateDirectory, capture.file), destination);
  }
  await writeCanonicalJson(join(outputDirectory, 'envelope.json'), envelope);
  await copyFile(resolve(requestPath), join(outputDirectory, 'request.json'));
  await mkdir(join(outputDirectory, 'base'), { recursive: true });
  await writeCanonicalJson(join(outputDirectory, 'base', 'manifest.json'), base.manifest);
  for (const [path, record] of base.records) {
    const destination = resolveInside(join(outputDirectory, 'base'), path);
    await mkdir(dirname(destination), { recursive: true });
    await writeCanonicalJson(destination, record);
  }
}

async function stageBatchBase(outputDirectory: string, base: Readonly<IntakeBase>): Promise<void> {
  const root = join(outputDirectory, 'base');
  await mkdir(root, { recursive: true });
  await writeCanonicalJson(join(root, 'manifest.json'), base.manifest);
  for (const [path, record] of base.records) {
    const destination = resolveInside(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeCanonicalJson(destination, record);
  }
}

async function validateBindings(
  base: Readonly<IntakeBase>,
  candidateDirectory: string,
  candidate: Readonly<CandidateManifest>,
  envelope: Readonly<DispatchEnvelope>,
  request: Readonly<FlightOracleRequest>,
  requestImageDifferences: Readonly<RequestImageDifferences>,
  requestPath: string,
  enforceRequestAge: boolean,
): Promise<RequestBindings> {
  if ((await hashFile(resolve(requestPath))) !== envelope.requestSha256) {
    throw new Error(`request checksum does not match dispatch envelope`);
  }
  if (envelope.requestPath !== `reference-image-requests/${request.id}.json`) {
    throw new Error(`dispatch request path ${envelope.requestPath} does not match request id ${request.id}`);
  }
  if (candidate.requestId !== request.id)
    throw new Error(`candidate request ${candidate.requestId} does not match ${request.id}`);
  if (requestImageDifferences.requestId !== request.id) {
    throw new Error(
      `request-image differences name request ${requestImageDifferences.requestId}, expected ${request.id}`,
    );
  }
  if (base.manifest.sourceRequests.some((entry) => entry.id === request.id)) {
    throw new Error(`request id ${request.id} was already used by a release`);
  }
  if (enforceRequestAge) assertRequestFreshness(envelope, base.intakePolicy);

  const environment = [...base.environments.values()].find((entry) => entry.id === candidate.environmentId);
  if (environment === undefined) throw new Error(`candidate names unknown environment ${candidate.environmentId}`);
  const policy = findPolicy(base.policies, candidate.comparisonPolicyId);
  if (policy.environmentId !== candidate.environmentId)
    throw new Error(`candidate policy and environment do not match`);

  const targets = new Map<string, FlightOracleRequest['targets'][number]>();
  for (const target of request.targets) {
    const key = `${request.subject}/${target.entry}/${target.renderer}`;
    if (targets.has(key)) throw new Error(`request overlaps target ${key}`);
    targets.set(key, target);
  }
  const differences = new Map<string, RequestImageDifferences['differences'][number]>();
  for (const difference of requestImageDifferences.differences) {
    const key = identityKey(difference.identity);
    const target = targets.get(key);
    if (target === undefined) throw new Error(`request-image differences include out-of-scope target ${key}`);
    if (differences.has(key)) throw new Error(`request-image differences repeat target ${key}`);
    if (difference.requestedPixelSha256 !== target.pixelSha256) {
      throw new Error(`request-image differences do not match requested pixels for ${key}`);
    }
    differences.set(key, difference);
  }
  const represented = new Set<string>();
  const captured = new Set<string>();
  const allowedFiles = new Set(['candidate.json', REQUEST_IMAGE_DIFFERENCES_FILE]);
  for (const capture of candidate.captures) {
    const key = identityKey(capture.identity);
    if (represented.has(key)) throw new Error(`candidate repeats target ${key}`);
    represented.add(key);
    if (!targets.has(key)) throw new Error(`candidate includes out-of-scope target ${key}`);
    if (capture.status === 'captured') {
      if (capture.file !== imagePath(capture.identity))
        throw new Error(`${key} image must be stored at ${imagePath(capture.identity)}`);
      if (capture.provenance?.frames !== request.frames) {
        throw new Error(
          `${key} captured at frame ${capture.provenance?.frames ?? 'unknown'}, request requires ${request.frames}`,
        );
      }
      captured.add(key);
      allowedFiles.add(capture.file);
    }
  }
  for (const key of targets.keys())
    if (!represented.has(key)) throw new Error(`candidate omits requested target ${key}`);
  for (const key of differences.keys()) {
    if (!captured.has(key)) throw new Error(`request-image differences name uncaptured target ${key}`);
  }
  for (const file of await findFiles(candidateDirectory)) {
    if (!allowedFiles.has(file)) throw new Error(`candidate bundle contains undeclared file ${file}`);
  }
  return { differences, targets };
}

interface RequestBindings {
  differences: ReadonlyMap<string, RequestImageDifferences['differences'][number]>;
  targets: ReadonlyMap<string, FlightOracleRequest['targets'][number]>;
}

function assertRequestedPixelEvidence(
  key: string,
  capturedPixelSha256: string,
  bindings: Readonly<RequestBindings>,
): void {
  const target = bindings.targets.get(key);
  if (target === undefined) throw new Error(`candidate includes unbound target ${key}`);
  const difference = bindings.differences.get(key);
  if (target.pixelSha256 === capturedPixelSha256) {
    if (difference !== undefined) throw new Error(`request-image differences claim unchanged target ${key}`);
    return;
  }
  if (difference === undefined) throw new Error(`candidate pixels for ${key} differ from the request without evidence`);
  if (difference.capturedPixelSha256 !== capturedPixelSha256) {
    throw new Error(`request-image differences do not match captured pixels for ${key}`);
  }
}

export function assertRequestFreshness(
  envelope: Readonly<DispatchEnvelope>,
  policy: Readonly<IntakePolicy>,
  now = new Date(),
): void {
  if (envelope.flightCommittedAt === undefined)
    throw new Error('dispatch envelope lacks authoritative Flight commit time');
  const committedAt = Date.parse(envelope.flightCommittedAt);
  if (!Number.isFinite(committedAt)) throw new Error(`invalid Flight commit time ${envelope.flightCommittedAt}`);
  const ageMilliseconds = now.getTime() - committedAt;
  const maximumAge = policy.maximumRequestAgeHours * 60 * 60 * 1000;
  const maximumFutureSkew = policy.maximumFutureSkewMinutes * 60 * 1000;
  if (ageMilliseconds > maximumAge) {
    throw new Error(
      `Flight request is ${Math.floor(ageMilliseconds / 3_600_000)} hours old; maximum is ${policy.maximumRequestAgeHours}`,
    );
  }
  if (ageMilliseconds < -maximumFutureSkew) {
    throw new Error(`Flight commit time is more than ${policy.maximumFutureSkewMinutes} minutes in the future`);
  }
}

async function validatePreparedIntakeFiles(
  directory: string,
  prepared: Readonly<PreparedIntake>,
  includeProspectivePacks = true,
): Promise<void> {
  const baseManifest = await readTyped<OracleManifest>(join(directory, 'base', 'manifest.json'), 'manifest');
  if (hashBytes(canonicalJson(baseManifest)) !== prepared.baseManifestSha256)
    throw new Error('prepared base manifest checksum differs');
  const baseRecords = await readOracleRecords(join(directory, 'base'));
  if (hashRecordMap(baseRecords) !== prepared.baseRecordsSha256)
    throw new Error('prepared base records checksum differs');
  const candidate = await readTyped<CandidateManifest>(join(directory, 'candidate', 'candidate.json'), 'candidate');
  if ((await hashCandidate(join(directory, 'candidate'), candidate)) !== prepared.candidateSha256) {
    throw new Error('prepared candidate checksum differs');
  }
  const envelope = await readTyped<DispatchEnvelope>(join(directory, 'envelope.json'), 'dispatch-envelope');
  if (hashBytes(canonicalJson(envelope)) !== prepared.envelopeSha256)
    throw new Error('prepared envelope checksum differs');
  if ((await hashFile(join(directory, 'request.json'))) !== prepared.requestSha256)
    throw new Error('prepared request checksum differs');
  if ((await hashFile(join(directory, 'expected', 'manifest.json'))) !== prepared.expectedManifestSha256) {
    throw new Error('prepared expected manifest checksum differs');
  }
  for (const record of prepared.records) {
    if ((await hashFile(resolveInside(join(directory, 'expected'), record.path))) !== record.sha256) {
      throw new Error(`prepared ${record.path} checksum differs`);
    }
  }
  if (includeProspectivePacks) {
    for (const pack of prepared.packs) {
      if ((await hashFile(join(directory, 'prospective-packs', pack.file))) !== pack.sha256) {
        throw new Error(`prepared ${pack.file} checksum differs`);
      }
    }
  }
}

async function validatePreparedBatchFiles(directory: string, prepared: Readonly<PreparedBatch>): Promise<void> {
  const approvalRequestIds = prepared.approvalSha256s.map((approval) => approval.requestId);
  if (canonicalJson(prepared.requestIds) !== canonicalJson(approvalRequestIds))
    throw new Error('prepared batch request and approval identities differ');
  if (new Set(prepared.requestIds).size !== prepared.requestIds.length)
    throw new Error('prepared batch repeats a request');
  if (new Set(prepared.records.map((record) => record.path)).size !== prepared.records.length)
    throw new Error('prepared batch repeats an oracle record');
  if (new Set(prepared.packs.map((pack) => pack.id)).size !== prepared.packs.length)
    throw new Error('prepared batch repeats a pack');
  const baseManifest = await readTyped<OracleManifest>(join(directory, 'base', 'manifest.json'), 'manifest');
  if (hashBytes(canonicalJson(baseManifest)) !== prepared.baseManifestSha256)
    throw new Error('prepared batch base manifest checksum differs');
  const baseRecords = await readOracleRecords(join(directory, 'base'));
  if (hashRecordMap(baseRecords) !== prepared.baseRecordsSha256)
    throw new Error('prepared batch base records checksum differs');
  const expectedManifest = await readTyped<OracleManifest>(join(directory, 'expected', 'manifest.json'), 'manifest');
  if (hashBytes(canonicalJson(expectedManifest)) !== prepared.expectedManifestSha256)
    throw new Error('prepared batch expected manifest checksum differs');
  if (
    expectedManifest.releaseTag !== prepared.releaseTag ||
    canonicalJson(expectedManifest.packs) !== canonicalJson(prepared.packs)
  )
    throw new Error('prepared batch expected manifest identity differs');
  if (
    expectedManifest.sourceRequests.length !== baseManifest.sourceRequests.length + prepared.requestIds.length ||
    canonicalJson(expectedManifest.sourceRequests.slice(0, baseManifest.sourceRequests.length)) !==
      canonicalJson(baseManifest.sourceRequests) ||
    canonicalJson(
      expectedManifest.sourceRequests.slice(baseManifest.sourceRequests.length).map((request) => request.id),
    ) !== canonicalJson(prepared.requestIds)
  )
    throw new Error('prepared batch expected manifest request set differs');
  for (const record of prepared.records)
    if ((await hashFile(resolveInside(join(directory, 'expected'), record.path))) !== record.sha256)
      throw new Error(`prepared batch ${record.path} checksum differs`);
  for (const pack of prepared.packs)
    if ((await hashFile(join(directory, 'prospective-packs', pack.file))) !== pack.sha256)
      throw new Error(`prepared batch ${pack.file} checksum differs`);
  const approvedRecordPaths: string[] = [];
  for (const expected of prepared.approvalSha256s) {
    const input = join(directory, 'inputs', expected.requestId);
    const approval = await readTyped<CandidateApproval>(join(input, 'approval.json'), 'approval');
    if (approval.requestId !== expected.requestId)
      throw new Error(`prepared batch approval identity differs for ${expected.requestId}`);
    if (hashBytes(canonicalJson(approval)) !== expected.sha256)
      throw new Error(`prepared batch approval ${expected.requestId} checksum differs`);
    const sourceRequest = expectedManifest.sourceRequests.find((request) => request.id === expected.requestId);
    if (
      sourceRequest === undefined ||
      sourceRequest.flightCommit !== approval.flightCommit ||
      sourceRequest.requestSha256 !== approval.requestSha256
    )
      throw new Error(`prepared batch manifest binding differs for ${expected.requestId}`);
    approvedRecordPaths.push(...approval.records.map((record) => record.path));
    await verifyMinimalApprovalInput(approval, input);
  }
  if (
    canonicalJson([...approvedRecordPaths].sort()) !==
    canonicalJson(prepared.records.map((record) => record.path).sort())
  )
    throw new Error('prepared batch record set differs from its approvals');
}

async function verifyMinimalApprovalInput(approval: Readonly<CandidateApproval>, directory: string): Promise<void> {
  const request = await readTyped<FlightOracleRequest>(join(directory, 'request.json'), 'request');
  const envelope = await readTyped<DispatchEnvelope>(join(directory, 'envelope.json'), 'dispatch-envelope');
  const candidate = await readTyped<CandidateManifest>(join(directory, 'candidate', 'candidate.json'), 'candidate');
  if (request.id !== approval.requestId || candidate.requestId !== approval.requestId)
    throw new Error(`approval input request differs from ${approval.requestId}`);
  if ((await hashFile(join(directory, 'request.json'))) !== approval.requestSha256)
    throw new Error(`approval input request hash differs for ${approval.requestId}`);
  if ((await hashCandidate(join(directory, 'candidate'), candidate)) !== approval.candidateSha256)
    throw new Error(`approval input candidate hash differs for ${approval.requestId}`);
  if (envelope.flightCommit !== approval.flightCommit || envelope.requestSha256 !== approval.requestSha256)
    throw new Error(`approval input envelope differs for ${approval.requestId}`);
  if (envelope.requestPath !== `reference-image-requests/${approval.requestId}.json`)
    throw new Error(`approval input request path differs for ${approval.requestId}`);
  const sourceArtifact: ArtifactLocator = {
    artifactId: envelope.artifactId,
    digest: envelope.artifactDigest,
    repository: envelope.repository,
    workflowRunId: envelope.workflowRunId,
  };
  if (canonicalJson(sourceArtifact) !== canonicalJson(approval.sourceArtifact))
    throw new Error(`approval input source artifact differs for ${approval.requestId}`);
  const basePaths = approval.baseRecords.map((record) => record.path);
  const recordPaths = approval.records.map((record) => record.path);
  if (canonicalJson(basePaths) !== canonicalJson(recordPaths))
    throw new Error(`approval input record scope differs for ${approval.requestId}`);
  for (const approved of approval.records) {
    const record = await readTyped<OracleRecord>(
      resolveInside(join(directory, 'expected'), approved.path),
      'oracle-record',
    );
    if (hashBytes(canonicalJson(record)) !== approved.sha256)
      throw new Error(`approval input ${approved.path} checksum differs for ${approval.requestId}`);
  }
}

async function readPreparedIntake(directory: string): Promise<PreparedIntake> {
  const prepared = await readTyped<PreparedIntake>(join(directory, 'prepared-intake.json'), 'prepared-intake');
  return prepared;
}

async function readPreparedBatch(directory: string): Promise<PreparedBatch> {
  return readTyped<PreparedBatch>(join(directory, 'prepared-batch.json'), 'prepared-batch');
}

async function readOracleRecords(root: string): Promise<Map<string, OracleRecord>> {
  const records = new Map<string, OracleRecord>();
  for (const relativePath of await findFiles(join(root, 'oracles'), '.json')) {
    const path = `oracles/${relativePath}`;
    records.set(path, await readTyped<OracleRecord>(join(root, path), 'oracle-record'));
  }
  return records;
}

async function readTyped<T>(path: string, schema: SchemaName): Promise<T> {
  const value = await readJson(path);
  assertSchema<T>(schema, value, path);
  return value;
}

async function hashCandidate(directory: string, candidate: Readonly<CandidateManifest>): Promise<string> {
  const paths = ['candidate.json', REQUEST_IMAGE_DIFFERENCES_FILE];
  for (const capture of candidate.captures)
    if (capture.status === 'captured' && capture.file !== undefined) paths.push(capture.file);
  return hashFileSet(directory, paths);
}

async function hashFileSet(root: string, paths: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) {
    hash.update(path);
    hash.update('\0');
    hash.update(await hashFile(resolveInside(root, path)));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function hashRecordMap(records: ReadonlyMap<string, OracleRecord>): string {
  const hash = createHash('sha256');
  for (const [path, record] of [...records].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path);
    hash.update('\0');
    hash.update(hashBytes(canonicalJson(record)));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function findPolicy(policies: ReadonlyMap<string, ComparisonPolicy>, id: string): ComparisonPolicy {
  const policy = [...policies.values()].find((entry) => entry.id === id);
  if (policy === undefined) throw new Error(`candidate names unknown comparison policy ${id}`);
  return policy;
}

function assertPreviousImage(
  path: string,
  decoded: Awaited<ReturnType<typeof readPng>>,
  record: Readonly<OracleRecord>,
): void {
  if (decoded.artifactSha256 !== record.artifactSha256) throw new Error(`${path} does not match prior artifact hash`);
  if (decoded.pixelSha256 !== record.pixelSha256) throw new Error(`${path} does not match prior pixel hash`);
  if (decoded.width !== record.width || decoded.height !== record.height)
    throw new Error(`${path} does not match prior dimensions`);
}

async function createNewDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`output directory already exists: ${path}`);
    }
    throw new Error(`cannot create output directory ${path}: ${errorMessage(error)}`);
  }
}
