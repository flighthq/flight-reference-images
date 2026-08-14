import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { canonicalJson, errorMessage, hashBytes, hashFile, readJson, writeCanonicalJson } from './json.js';
import { buildReleasePacks, extractVerifiedReleasePacks, verifyReleasePacks } from './pack.js';
import { findFiles, identityKey, imagePath, oracleRecordPath, resolveInside, resolvePack } from './paths.js';
import { comparePngs, createDeltaPng, DimensionMismatchError, evaluateMismatch, readPng } from './png.js';
import { readRepository } from './repository.js';
import { writeReviewReport, type ReviewRow } from './report.js';
import { assertSchema } from './schemas.js';
import type { SchemaName } from './schemas.js';
import type {
  CandidateLocator,
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
} from './types.js';

export interface ApplyIntakeOptions {
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
      repository: 'flighthq/flight-oracles',
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
    if (
      (await readFile(resolveInside(replayExpected, record.path), 'utf8')) !==
      canonicalJson(committed.records.get(record.path))
    ) {
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

async function produceIntake(
  base: Readonly<IntakeBase>,
  options: Readonly<ProduceIntakeOptions>,
): Promise<PreparedIntake> {
  const candidateDirectory = resolve(options.candidateDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  await createNewDirectory(outputDirectory);

  const workspace = await mkdtemp(join(tmpdir(), 'flight-oracles-intake-'));
  try {
    const candidate = await readTyped<CandidateManifest>(join(candidateDirectory, 'candidate.json'), 'candidate');
    const envelope = await readTyped<DispatchEnvelope>(resolve(options.envelopePath), 'dispatch-envelope');
    const request = await readTyped<FlightOracleRequest>(resolve(options.requestPath), 'request');
    await validateBindings(
      base,
      candidateDirectory,
      candidate,
      envelope,
      request,
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
      const decoded = await readPng(sourcePath);
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

async function validateBindings(
  base: Readonly<IntakeBase>,
  candidateDirectory: string,
  candidate: Readonly<CandidateManifest>,
  envelope: Readonly<DispatchEnvelope>,
  request: Readonly<FlightOracleRequest>,
  requestPath: string,
  enforceRequestAge: boolean,
): Promise<void> {
  if ((await hashFile(resolve(requestPath))) !== envelope.requestSha256) {
    throw new Error(`request checksum does not match dispatch envelope`);
  }
  if (envelope.requestPath !== `oracle-requests/${request.id}.json`) {
    throw new Error(`dispatch request path ${envelope.requestPath} does not match request id ${request.id}`);
  }
  if (candidate.requestId !== request.id)
    throw new Error(`candidate request ${candidate.requestId} does not match ${request.id}`);
  if (base.manifest.sourceRequests.some((entry) => entry.id === request.id)) {
    throw new Error(`request id ${request.id} was already used by a release`);
  }
  if (enforceRequestAge) assertRequestFreshness(envelope, base.intakePolicy);

  const environment = [...base.environments.values()].find((entry) => entry.id === candidate.environmentId);
  if (environment === undefined) throw new Error(`candidate names unknown environment ${candidate.environmentId}`);
  const policy = findPolicy(base.policies, candidate.comparisonPolicyId);
  if (policy.environmentId !== candidate.environmentId)
    throw new Error(`candidate policy and environment do not match`);

  const expected = new Set<string>();
  for (const target of request.targets) {
    for (const renderer of target.renderers) {
      const key = `${request.subject}/${target.entry}/${renderer}`;
      if (expected.has(key)) throw new Error(`request overlaps target ${key}`);
      expected.add(key);
    }
  }
  const represented = new Set<string>();
  const allowedFiles = new Set(['candidate.json']);
  for (const capture of candidate.captures) {
    const key = identityKey(capture.identity);
    if (represented.has(key)) throw new Error(`candidate repeats target ${key}`);
    represented.add(key);
    if (!expected.has(key)) throw new Error(`candidate includes out-of-scope target ${key}`);
    if (capture.status === 'captured') {
      if (capture.file !== imagePath(capture.identity))
        throw new Error(`${key} image must be stored at ${imagePath(capture.identity)}`);
      if (capture.provenance?.frames !== request.frames) {
        throw new Error(
          `${key} captured at frame ${capture.provenance?.frames ?? 'unknown'}, request requires ${request.frames}`,
        );
      }
      allowedFiles.add(capture.file);
    }
  }
  for (const key of expected) if (!represented.has(key)) throw new Error(`candidate omits requested target ${key}`);
  for (const file of await findFiles(candidateDirectory)) {
    if (!allowedFiles.has(file)) throw new Error(`candidate bundle contains undeclared file ${file}`);
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

async function validatePreparedIntakeFiles(directory: string, prepared: Readonly<PreparedIntake>): Promise<void> {
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
  for (const pack of prepared.packs) {
    if ((await hashFile(join(directory, 'prospective-packs', pack.file))) !== pack.sha256) {
      throw new Error(`prepared ${pack.file} checksum differs`);
    }
  }
}

async function readPreparedIntake(directory: string): Promise<PreparedIntake> {
  const prepared = await readTyped<PreparedIntake>(join(directory, 'prepared-intake.json'), 'prepared-intake');
  return prepared;
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
  const paths = ['candidate.json'];
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
  try {
    await lstat(path);
    throw new Error(`output directory already exists: ${path}`);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      await mkdir(path, { recursive: true });
      return;
    }
    throw new Error(`cannot create output directory ${path}: ${errorMessage(error)}`);
  }
}
