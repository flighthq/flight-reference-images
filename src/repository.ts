import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson, hashBytes, readJson } from './json.js';
import { findFiles, oracleRecordPath, resolvePack } from './paths.js';
import { assertSchema } from './schemas.js';
import type { SchemaName } from './schemas.js';
import type {
  CandidateLocator,
  ComparisonPolicy,
  EnvironmentDescriptor,
  OracleManifest,
  OracleRecord,
  PackConfiguration,
} from './types.js';

export interface RepositoryState {
  environments: ReadonlyMap<string, EnvironmentDescriptor>;
  locators: readonly CandidateLocator[];
  manifest: OracleManifest;
  packConfiguration: PackConfiguration;
  policies: ReadonlyMap<string, ComparisonPolicy>;
  records: ReadonlyMap<string, OracleRecord>;
}

export async function readRepository(root: string): Promise<RepositoryState> {
  const problems: string[] = [];
  const manifest = await readTyped<OracleManifest>(root, 'manifest.json', 'manifest', problems);
  const packConfiguration = await readTyped<PackConfiguration>(root, 'pack-config.json', 'pack-config', problems);
  const environments = await readDirectory<EnvironmentDescriptor>(root, 'environments', 'environment', problems);
  const policies = await readDirectory<ComparisonPolicy>(root, 'comparison-policies', 'comparison-policy', problems);
  const records = await readDirectory<OracleRecord>(root, 'oracles', 'oracle-record', problems);
  const locatorMap = await readDirectory<CandidateLocator>(root, 'candidates', 'candidate-locator', problems);

  if (manifest !== null && packConfiguration !== null) {
    validateRepositoryRelationships(
      root,
      manifest,
      packConfiguration,
      environments,
      policies,
      records,
      locatorMap,
      problems,
    );
  }

  if (problems.length > 0)
    throw new Error(
      `repository validation failed:\n${problems
        .sort()
        .map((item) => `  - ${item}`)
        .join('\n')}`,
    );
  if (manifest === null || packConfiguration === null)
    throw new Error('repository validation failed without a diagnostic');

  return {
    environments,
    locators: [...locatorMap.values()],
    manifest,
    packConfiguration,
    policies,
    records,
  };
}

async function readDirectory<T>(
  root: string,
  directory: string,
  schema: SchemaName,
  problems: string[],
): Promise<Map<string, T>> {
  const values = new Map<string, T>();
  for (const relativePath of await findFiles(join(root, directory), '.json')) {
    const path = `${directory}/${relativePath}`;
    const value = await readTyped<T>(root, path, schema, problems);
    if (value !== null) values.set(path, value);
  }
  return values;
}

async function readTyped<T>(root: string, path: string, schema: SchemaName, problems: string[]): Promise<T | null> {
  try {
    const value = await readJson(join(root, path));
    assertSchema<T>(schema, value, path);
    return value;
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return null;
  }
}

function validateRepositoryRelationships(
  root: string,
  manifest: Readonly<OracleManifest>,
  packConfiguration: Readonly<PackConfiguration>,
  environments: ReadonlyMap<string, EnvironmentDescriptor>,
  policies: ReadonlyMap<string, ComparisonPolicy>,
  records: ReadonlyMap<string, OracleRecord>,
  locators: ReadonlyMap<string, CandidateLocator>,
  problems: string[],
): void {
  const environmentsById = indexUnique(environments, (value) => value.id, 'environment id', problems);
  const policiesById = indexUnique(policies, (value) => value.id, 'comparison policy id', problems);
  const packEntries = indexUnique(
    new Map(manifest.packs.map((entry) => [entry.id, entry])),
    (value) => value.id,
    'pack id',
    problems,
  );

  for (const [path, environment] of environments) {
    const expectedPath = `environments/${environment.id}.json`;
    if (path !== expectedPath) problems.push(`${path} must be stored at ${expectedPath}`);
    const { $schema: ignoredSchema, id: ignoredId, ...descriptor } = environment;
    void ignoredSchema;
    void ignoredId;
    const expectedId = `sha256-${hashBytes(canonicalJson(descriptor))}`;
    if (environment.id !== expectedId) problems.push(`${path} id is ${environment.id}, expected ${expectedId}`);
  }

  for (const [path, policy] of policies) {
    const expectedPath = `comparison-policies/${policy.id}.json`;
    if (path !== expectedPath) problems.push(`${path} must be stored at ${expectedPath}`);
    const environment = environmentsById.get(policy.environmentId);
    if (environment === undefined) problems.push(`${path} names unknown environment ${policy.environmentId}`);
  }

  const recordCounts = new Map<string, number>();
  for (const [path, record] of records) {
    const expectedPath = oracleRecordPath(record.identity);
    if (path !== expectedPath) problems.push(`${path} must be stored at ${expectedPath}`);
    const environment = environmentsById.get(record.environmentId);
    const policy = policiesById.get(record.comparisonPolicyId);
    if (environment === undefined) problems.push(`${path} names unknown environment ${record.environmentId}`);
    if (policy === undefined) problems.push(`${path} names unknown comparison policy ${record.comparisonPolicyId}`);
    else if (policy.environmentId !== record.environmentId) {
      problems.push(
        `${path} environment ${record.environmentId} does not match policy environment ${policy.environmentId}`,
      );
    }
    try {
      const expectedPack = resolvePack(record.identity, packConfiguration);
      if (record.pack !== expectedPack) problems.push(`${path} names pack ${record.pack}, expected ${expectedPack}`);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    if (!packEntries.has(record.pack))
      problems.push(`${path} names pack ${record.pack}, which is absent from manifest.json`);
    recordCounts.set(record.pack, (recordCounts.get(record.pack) ?? 0) + 1);
  }

  for (const pack of manifest.packs) {
    const count = recordCounts.get(pack.id) ?? 0;
    if (count !== pack.imageCount)
      problems.push(`manifest pack ${pack.id} declares ${pack.imageCount} images, but ${count} records name it`);
    if (manifest.releaseTag !== null && pack.file !== `${pack.id}-${manifest.releaseTag}.tgz`) {
      problems.push(`manifest pack ${pack.id} file ${pack.file} does not match release ${manifest.releaseTag}`);
    }
  }

  const requestIds = new Set<string>();
  for (const request of manifest.sourceRequests) {
    if (requestIds.has(request.id)) problems.push(`manifest repeats source request ${request.id}`);
    requestIds.add(request.id);
  }

  if (locators.size > 1)
    problems.push(`candidates contains ${locators.size} live locators; only the current release locator may remain`);
  for (const [path, locator] of locators) {
    const expectedPath = `candidates/${locator.requestId}.json`;
    if (path !== expectedPath) problems.push(`${path} must be stored at ${expectedPath}`);
    if (manifest.releaseTag !== locator.releaseTag) problems.push(`${path} release does not match manifest release`);
    if (!requestIds.has(locator.requestId)) problems.push(`${path} request is absent from manifest sourceRequests`);
  }

  void root;
}

function indexUnique<T>(
  source: ReadonlyMap<string, T>,
  getKey: (value: T) => string,
  label: string,
  problems: string[],
): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const [path, value] of source) {
    const key = getKey(value);
    if (indexed.has(key)) problems.push(`${path} repeats ${label} ${key}`);
    indexed.set(key, value);
  }
  return indexed;
}

export async function assertCanonicalJsonFiles(root: string): Promise<void> {
  const problems: string[] = [];
  for (const path of await findFiles(root, '.json')) {
    if (path.startsWith('node_modules/') || path.startsWith('.git/')) continue;
    const fullPath = join(root, path);
    const value = await readJson(fullPath);
    const actual = await readFile(fullPath, 'utf8');
    if (actual !== canonicalJson(value)) problems.push(`${path} is not canonical JSON`);
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
}
