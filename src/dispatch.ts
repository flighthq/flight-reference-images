import { assertSchema } from './schemas.js';
import type { BatchDispatchEnvelope, DispatchEnvelope } from './types.js';

export interface BatchDispatchPlan {
  candidates: DispatchEnvelope[];
  skipped: Array<{
    reason: 'already-merged' | 'already-under-review';
    requestId: string;
  }>;
}

export function expandBatchDispatch(value: unknown): DispatchEnvelope[] {
  assertSchema<BatchDispatchEnvelope>('dispatch-batch', value);
  const requestPaths = new Set<string>();
  const artifactIds = new Set<number>();
  for (const candidate of value.candidates) {
    if (requestPaths.has(candidate.requestPath)) {
      throw new Error(`batch dispatch repeats request path ${candidate.requestPath}`);
    }
    if (artifactIds.has(candidate.artifactId)) {
      throw new Error(`batch dispatch repeats artifact id ${candidate.artifactId}`);
    }
    requestPaths.add(candidate.requestPath);
    artifactIds.add(candidate.artifactId);
  }

  return [...value.candidates]
    .sort((left, right) => left.requestPath.localeCompare(right.requestPath))
    .map((candidate) => ({
      artifactDigest: candidate.artifactDigest,
      artifactId: candidate.artifactId,
      flightCommit: value.flightCommit,
      repository: value.repository,
      requestPath: candidate.requestPath,
      requestSha256: candidate.requestSha256,
      schemaVersion: 1,
      workflowRunId: value.workflowRunId,
    }));
}

export function planBatchDispatch(
  value: unknown,
  mergedRequestIds: ReadonlySet<string>,
  pendingRequestIds: ReadonlySet<string>,
): BatchDispatchPlan {
  const candidates: DispatchEnvelope[] = [];
  const skipped: BatchDispatchPlan['skipped'] = [];
  for (const candidate of expandBatchDispatch(value)) {
    const requestId = candidate.requestPath.slice('reference-image-requests/'.length, -'.json'.length);
    if (mergedRequestIds.has(requestId)) {
      skipped.push({ reason: 'already-merged', requestId });
    } else if (pendingRequestIds.has(requestId)) {
      skipped.push({ reason: 'already-under-review', requestId });
    } else {
      candidates.push(candidate);
    }
  }
  return { candidates, skipped };
}
