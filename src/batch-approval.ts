import { isRecord } from './json.js';

export interface BatchApprovalArtifactSet {
  artifactDigest: string;
  artifactId: number;
  reportId: number;
  requestId: string;
}

export function resolveBatchApprovalArtifacts(
  value: unknown,
  workflowRunId: number,
  expectedCount: number,
): BatchApprovalArtifactSet[] {
  if (!Array.isArray(value) || value.some((page) => !isRecord(page) || !Array.isArray(page['artifacts']))) {
    throw new Error('batch artifact API response must contain pages of artifacts');
  }
  const artifacts = value.flatMap((page) => (page as Record<string, unknown>)['artifacts'] as unknown[]);
  const suffix = `-${workflowRunId}`;
  const candidates = collectArtifacts(artifacts, 'oracle-candidate-', suffix);
  const reports = collectArtifacts(artifacts, 'oracle-review-', suffix);
  if (candidates.size !== expectedCount || reports.size !== expectedCount) {
    throw new Error(
      `batch produced ${candidates.size} candidate and ${reports.size} review artifacts; expected ${expectedCount} of each`,
    );
  }
  if ([...candidates.keys()].some((requestId) => !reports.has(requestId))) {
    throw new Error('batch candidate and review artifact membership differs');
  }

  return [...candidates]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([requestId, candidate]) => {
      const report = reports.get(requestId)!;
      if (candidate.expired !== false || report.expired !== false) {
        throw new Error(`batch artifacts for ${requestId} are expired or have no fixed retention state`);
      }
      const artifactId = positiveArtifactId(candidate.id, requestId);
      const reportId = positiveArtifactId(report.id, requestId);
      if (typeof candidate.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(candidate.digest)) {
        throw new Error(`prepared artifact for ${requestId} has an invalid digest`);
      }
      return { artifactDigest: candidate.digest, artifactId, reportId, requestId };
    });
}

function collectArtifacts(
  artifacts: readonly unknown[],
  prefix: string,
  suffix: string,
): Map<string, Record<string, unknown>> {
  const collected = new Map<string, Record<string, unknown>>();
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || typeof artifact['name'] !== 'string') continue;
    if (!artifact['name'].startsWith(prefix) || !artifact['name'].endsWith(suffix)) continue;
    const requestId = artifact['name'].slice(prefix.length, -suffix.length);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(requestId)) throw new Error(`batch artifact has invalid request id ${requestId}`);
    if (collected.has(requestId)) throw new Error(`batch contains multiple ${prefix} artifacts for ${requestId}`);
    collected.set(requestId, artifact);
  }
  return collected;
}

function positiveArtifactId(value: unknown, requestId: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`batch artifacts for ${requestId} have invalid ids`);
  }
  return value as number;
}
