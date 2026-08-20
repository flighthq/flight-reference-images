import { assertSchema } from './schemas.js';
import type { BatchDispatchEnvelope, DispatchEnvelope } from './types.js';

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
