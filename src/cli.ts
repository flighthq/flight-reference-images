#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { renderApprovalSummary, requestDisplayLabel } from './approval.js';
import {
  approvalBaseMismatch,
  deferApproval,
  selectPublishableApprovals,
  type DeferredApproval,
} from './approval-selection.js';
import { resolveBatchApprovalArtifacts } from './batch-approval.js';
import { completeFlight, reconcileFlight } from './completion.js';
import { expandBatchDispatch, planBatchDispatch } from './dispatch.js';
import {
  applyPreparedIntake,
  applyPreparedBatch,
  approvePreparedIntake,
  prepareIntake,
  prepareApprovedBatch,
  replayPreparedBatch,
  replayPreparedIntake,
  verifyPreparedApproval,
} from './intake.js';
import { canonicalJson, errorMessage, hashBytes, isRecord, readJson } from './json.js';
import { downloadReleasePacks, verifyReleasePacks } from './pack.js';
import { requireCurrentRelease } from './release-readiness.js';
import { readRepository } from './repository.js';
import { assertSchema } from './schemas.js';
import type { SchemaName } from './schemas.js';
import type { CandidateApproval, FlightOracleRequest, OracleManifest } from './types.js';

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === 'check') {
    const root = resolve(option(arguments_, '--root') ?? '.');
    const state = await readRepository(root);
    console.log(
      `repository valid: ${state.records.size} oracle records, ${state.manifest.packs.length} packs, ${state.policies.size} policies`,
    );
    return;
  }

  if (command === 'approval-label' || command === 'approval-summary') {
    const requestPath = resolve(requiredOption(arguments_, '--request'));
    const value = await readJson(requestPath);
    assertSchema<FlightOracleRequest>('request', value, requestPath);
    if (command === 'approval-label') {
      console.log(requestDisplayLabel(value));
      return;
    }
    const output = resolve(requiredOption(arguments_, '--output'));
    await writeFile(
      output,
      renderApprovalSummary({
        releaseTag: requiredOption(arguments_, '--release-tag'),
        reportUrl: requiredOption(arguments_, '--report-url'),
        request: value,
      }),
      'utf8',
    );
    console.log(requestDisplayLabel(value));
    return;
  }

  if (command === 'approval-status') {
    const root = resolve(option(arguments_, '--root') ?? '.');
    const requestId = requiredIdentifierOption(arguments_, '--request-id');
    const repository = await readRepository(root);
    if (repository.manifest.sourceRequests.some((request) => request.id === requestId)) {
      console.log('released');
      return;
    }
    const approval = repository.approvals.get(`approvals/${requestId}.json`);
    if (approval === undefined) {
      console.log('absent');
      return;
    }
    console.log(approvalBaseMismatch(approval, repository.records) === undefined ? 'publishable' : 'stale');
    return;
  }

  if (command === 'dispatch-expand') {
    const file = resolve(requiredOption(arguments_, '--file'));
    console.log(JSON.stringify(expandBatchDispatch(await readJson(file))));
    return;
  }

  if (command === 'dispatch-plan') {
    const file = resolve(requiredOption(arguments_, '--file'));
    const root = resolve(option(arguments_, '--root') ?? '.');
    const pendingPath = resolve(requiredOption(arguments_, '--pending'));
    const pendingRequestIds = identifierArray(await readJson(pendingPath), pendingPath);
    const repository = await readRepository(root);
    const mergedRequestIds = new Set([
      ...[...repository.approvals.values()]
        .filter((approval) => approvalBaseMismatch(approval, repository.records) === undefined)
        .map((approval) => approval.requestId),
      ...repository.manifest.sourceRequests.map((request) => request.id),
    ]);
    console.log(JSON.stringify(planBatchDispatch(await readJson(file), mergedRequestIds, new Set(pendingRequestIds))));
    return;
  }

  if (command === 'batch-approval-artifacts') {
    const file = resolve(requiredOption(arguments_, '--file'));
    const expectedPath = resolve(requiredOption(arguments_, '--expected-request-ids'));
    const artifacts = resolveBatchApprovalArtifacts(
      await readJson(file),
      positiveIntegerOption(arguments_, '--workflow-run-id'),
      identifierArray(await readJson(expectedPath), expectedPath),
    );
    console.log(JSON.stringify(artifacts));
    return;
  }

  if (command === 'batch-pending-approvals') {
    const root = resolve(option(arguments_, '--root') ?? '.');
    const repository = await readRepository(root);
    const released = new Set(repository.manifest.sourceRequests.map((request) => request.id));
    const pending = [...repository.approvals.values()]
      .filter((approval) => !released.has(approval.requestId))
      .sort((left, right) => left.requestId.localeCompare(right.requestId));
    const candidates: CandidateApproval[] = [];
    const deferred: DeferredApproval[] = [];
    for (const approval of pending) {
      const stalePath = approvalBaseMismatch(approval, repository.records);
      if (stalePath === undefined) candidates.push(approval);
      else deferred.push(deferApproval(approval, `review base no longer matches ${stalePath}`));
    }
    console.log(JSON.stringify({ candidates, deferred }));
    return;
  }

  if (command === 'batch-select-approvals') {
    const root = resolve(option(arguments_, '--root') ?? '.');
    const requestIdsPath = resolve(requiredOption(arguments_, '--request-ids'));
    const requestIds = identifierArray(await readJson(requestIdsPath), requestIdsPath);
    const requested = new Set(requestIds);
    const repository = await readRepository(root);
    const released = new Set(repository.manifest.sourceRequests.map((request) => request.id));
    const candidates = requestIds.map((requestId) => {
      if (released.has(requestId)) throw new Error(`cannot select released approval ${requestId}`);
      const approval = repository.approvals.get(`approvals/${requestId}.json`);
      if (approval === undefined) throw new Error(`cannot select missing approval ${requestId}`);
      return approval;
    });
    const reserved = [...repository.approvals.values()].filter(
      (approval) => !released.has(approval.requestId) && !requested.has(approval.requestId),
    );
    const selection = selectPublishableApprovals(candidates, repository.records, reserved);
    console.log(
      JSON.stringify({
        deferred: selection.deferred,
        selectedRequestIds: selection.selected.map((approval) => approval.requestId),
      }),
    );
    return;
  }

  if (command === 'packs-download') {
    const root = resolve(option(arguments_, '--root') ?? '.');
    const output = resolve(requiredOption(arguments_, '--output'));
    const repository = option(arguments_, '--repository') ?? 'flighthq/flight-reference-images';
    const manifestPath = option(arguments_, '--manifest');
    let manifest: OracleManifest;
    if (manifestPath === undefined) manifest = (await readRepository(root)).manifest;
    else {
      const value = await readJson(resolve(manifestPath));
      assertSchema<OracleManifest>('manifest', value, manifestPath);
      manifest = value;
    }
    const attempts = option(arguments_, '--attempts');
    const retryDelay = option(arguments_, '--retry-delay-ms');
    await downloadReleasePacks(manifest, repository, output, {
      attempts: attempts === undefined ? 1 : parsePositiveInteger(attempts, '--attempts'),
      retryDelayMilliseconds: retryDelay === undefined ? 0 : parseNonNegativeInteger(retryDelay, '--retry-delay-ms'),
    });
    console.log(`downloaded and verified ${manifest.packs.length} packs in ${output}`);
    return;
  }

  if (command === 'release-readiness') {
    const root = resolve(option(arguments_, '--root') ?? '.');
    const output = resolve(requiredOption(arguments_, '--output'));
    const repository = option(arguments_, '--repository') ?? 'flighthq/flight-reference-images';
    const state = await readRepository(root);
    const attempts = option(arguments_, '--attempts');
    const retryDelay = option(arguments_, '--retry-delay-ms');
    await requireCurrentRelease({
      attempts: attempts === undefined ? 1 : parsePositiveInteger(attempts, '--attempts'),
      branch: option(arguments_, '--branch') ?? 'main',
      manifest: state.manifest,
      outputDirectory: output,
      repository,
      repositoryRoot: root,
      retryDelayMilliseconds: retryDelay === undefined ? 0 : parseNonNegativeInteger(retryDelay, '--retry-delay-ms'),
    });
    console.log(`current release ready: ${state.manifest.releaseTag ?? 'bootstrap'}`);
    return;
  }

  if (command === 'intake-prepare') {
    const prepared = await prepareIntake({
      candidateDirectory: requiredOption(arguments_, '--candidate'),
      envelopePath: requiredOption(arguments_, '--envelope'),
      outputDirectory: requiredOption(arguments_, '--output'),
      previousPackDirectory: requiredOption(arguments_, '--previous-packs'),
      repositoryRoot: option(arguments_, '--root') ?? '.',
      requestPath: requiredOption(arguments_, '--request'),
    });
    console.log(JSON.stringify(prepared));
    return;
  }

  if (command === 'intake-apply') {
    const locator = await applyPreparedIntake({
      artifactDigest: requiredOption(arguments_, '--artifact-digest'),
      artifactId: positiveIntegerOption(arguments_, '--artifact-id'),
      preparedDirectory: requiredOption(arguments_, '--prepared'),
      repositoryRoot: option(arguments_, '--root') ?? '.',
      workflowRunId: positiveIntegerOption(arguments_, '--workflow-run-id'),
    });
    console.log(JSON.stringify(locator));
    return;
  }

  if (command === 'intake-approve') {
    const approval = await approvePreparedIntake({
      artifactDigest: requiredOption(arguments_, '--artifact-digest'),
      artifactId: positiveIntegerOption(arguments_, '--artifact-id'),
      preparedDirectory: requiredOption(arguments_, '--prepared'),
      repositoryRoot: option(arguments_, '--root') ?? '.',
      workflowRunId: positiveIntegerOption(arguments_, '--workflow-run-id'),
    });
    console.log(JSON.stringify(approval));
    return;
  }

  if (command === 'intake-verify-approval') {
    const approvalPath = resolve(requiredOption(arguments_, '--approval'));
    const value = await readJson(approvalPath);
    assertSchema<CandidateApproval>('approval', value, approvalPath);
    await verifyPreparedApproval(value, requiredOption(arguments_, '--prepared'));
    console.log(`verified approval ${value.requestId}`);
    return;
  }

  if (command === 'intake-replay') {
    const prepared = await replayPreparedIntake({
      outputDirectory: requiredOption(arguments_, '--output'),
      preparedDirectory: requiredOption(arguments_, '--prepared'),
      previousPackDirectory: requiredOption(arguments_, '--previous-packs'),
      repositoryRoot: option(arguments_, '--root') ?? '.',
    });
    console.log(JSON.stringify(prepared));
    return;
  }

  if (command === 'batch-prepare') {
    const prepared = await prepareApprovedBatch({
      outputDirectory: requiredOption(arguments_, '--output'),
      preparedRoot: requiredOption(arguments_, '--prepared-root'),
      previousPackDirectory: requiredOption(arguments_, '--previous-packs'),
      repositoryRoot: option(arguments_, '--root') ?? '.',
    });
    console.log(JSON.stringify(prepared));
    return;
  }

  if (command === 'batch-apply') {
    const locator = await applyPreparedBatch({
      artifactDigest: requiredOption(arguments_, '--artifact-digest'),
      artifactId: positiveIntegerOption(arguments_, '--artifact-id'),
      preparedDirectory: requiredOption(arguments_, '--prepared'),
      repositoryRoot: option(arguments_, '--root') ?? '.',
      workflowRunId: positiveIntegerOption(arguments_, '--workflow-run-id'),
    });
    console.log(JSON.stringify(locator));
    return;
  }

  if (command === 'batch-replay') {
    const prepared = await replayPreparedBatch({
      outputDirectory: requiredOption(arguments_, '--output'),
      preparedDirectory: requiredOption(arguments_, '--prepared'),
      previousPackDirectory: requiredOption(arguments_, '--previous-packs'),
      repositoryRoot: option(arguments_, '--root') ?? '.',
    });
    console.log(JSON.stringify(prepared));
    return;
  }

  if (command === 'release-verify') {
    const root = resolve(option(arguments_, '--root') ?? '.');
    const packs = resolve(requiredOption(arguments_, '--packs'));
    const state = await readRepository(root);
    await verifyReleasePacks(state.manifest, state.records, packs);
    console.log(`release valid: ${state.records.size} images in ${state.manifest.packs.length} packs`);
    return;
  }

  if (command === 'schema-check') {
    const schema = requiredOption(arguments_, '--schema') as SchemaName;
    const file = resolve(requiredOption(arguments_, '--file'));
    assertSchema(schema, await readJson(file), file);
    console.log(`${file} matches ${schema}`);
    return;
  }

  if (command === 'flight-complete') {
    const lock = await completeFlight({
      flightRoot: requiredOption(arguments_, '--flight-root'),
      oracleCommit: requiredOption(arguments_, '--oracle-commit'),
      oracleRoot: option(arguments_, '--root') ?? '.',
      requestId: requiredOption(arguments_, '--request-id'),
    });
    console.log(JSON.stringify(lock));
    return;
  }

  if (command === 'flight-reconcile') {
    const requestIds = requiredOption(arguments_, '--request-ids').split(',');
    const result = await reconcileFlight({
      flightRoot: requiredOption(arguments_, '--flight-root'),
      oracleCommit: requiredOption(arguments_, '--oracle-commit'),
      oracleRoot: option(arguments_, '--root') ?? '.',
      requestIds,
    });
    console.log(JSON.stringify(result));
    return;
  }

  if (command === 'environment-id') {
    const file = resolve(requiredOption(arguments_, '--file'));
    const value = await readJson(file);
    if (!isRecord(value)) throw new Error(`${file} must contain a JSON object`);
    const { $schema, id: ignoredId, ...descriptor } = value;
    void ignoredId;
    const id = `sha256-${hashBytes(canonicalJson(descriptor))}`;
    const complete = $schema === undefined ? { ...descriptor, id } : { $schema, ...descriptor, id };
    assertSchema('environment', complete, file);
    console.log(id);
    return;
  }

  throw new Error(`unknown command ${command ?? '(none)'}`);
}

function positiveIntegerOption(arguments_: readonly string[], name: string): number {
  return parsePositiveInteger(requiredOption(arguments_, name), name);
}

function requiredIdentifierOption(arguments_: readonly string[], name: string): string {
  const value = requiredOption(arguments_, name);
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/u.test(value)) throw new Error(`${name} must be a request id, got ${value}`);
  return value;
}

function parsePositiveInteger(text: string, name: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got ${text}`);
  return value;
}

function parseNonNegativeInteger(text: string, name: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got ${text}`);
  return value;
}

function requiredOption(arguments_: readonly string[], name: string): string {
  const value = option(arguments_, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function identifierArray(value: unknown, source: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !/^[a-z0-9][a-z0-9-]{0,119}$/u.test(item))
  ) {
    throw new Error(`${source} must contain an array of request ids`);
  }
  const requestIds = value as string[];
  if (new Set(requestIds).size !== requestIds.length) throw new Error(`${source} repeats a request id`);
  return requestIds;
}

main().catch((error: unknown) => {
  console.error(`flight-reference-images: ${errorMessage(error)}`);
  process.exitCode = 1;
});
