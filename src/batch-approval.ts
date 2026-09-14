import { errorMessage, isRecord } from './json.js';

export interface BatchApprovalArtifactSet {
  artifactDigest: string;
  artifactId: number;
  reportId: number;
  requestId: string;
}

export interface BatchApprovalArtifactResolution {
  ready: BatchApprovalArtifactSet[];
  skipped: Array<{ reason: string; requestId: string }>;
}

export function resolveBatchApprovalArtifacts(
  value: unknown,
  workflowRunId: number,
  expectedRequestIds: readonly string[],
): BatchApprovalArtifactResolution {
  if (!Array.isArray(value) || value.some((page) => !isRecord(page) || !Array.isArray(page['artifacts']))) {
    throw new Error('batch artifact API response must contain pages of artifacts');
  }
  const expected = new Set<string>();
  for (const requestId of expectedRequestIds) {
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/u.test(requestId)) {
      throw new Error(`batch expects invalid request id ${requestId}`);
    }
    if (expected.has(requestId)) throw new Error(`batch expects request ${requestId} more than once`);
    expected.add(requestId);
  }
  const artifacts = value.flatMap((page) => (page as Record<string, unknown>)['artifacts'] as unknown[]);
  const suffix = `-${workflowRunId}`;
  const candidates = collectArtifacts(artifacts, 'oracle-candidate-', suffix);
  const reports = collectArtifacts(artifacts, 'oracle-review-', suffix);
  const unexpected = new Set([...candidates.keys(), ...reports.keys()].filter((requestId) => !expected.has(requestId)));
  if (unexpected.size > 0) {
    throw new Error(`batch produced artifacts for unexpected request(s): ${[...unexpected].sort().join(', ')}`);
  }

  const ready: BatchApprovalArtifactSet[] = [];
  const skipped: BatchApprovalArtifactResolution['skipped'] = [];
  for (const requestId of [...expected].sort()) {
    const candidateSet = candidates.get(requestId) ?? [];
    const reportSet = reports.get(requestId) ?? [];
    if (candidateSet.length !== 1 || reportSet.length !== 1) {
      const missing = [
        candidateSet.length === 0 ? 'prepared candidate' : undefined,
        reportSet.length === 0 ? 'visual review' : undefined,
      ].filter((part): part is string => part !== undefined);
      const duplicates = [
        candidateSet.length > 1 ? 'multiple prepared candidates' : undefined,
        reportSet.length > 1 ? 'multiple visual reviews' : undefined,
      ].filter((part): part is string => part !== undefined);
      skipped.push({ reason: [...missing.map((part) => `missing ${part}`), ...duplicates].join('; '), requestId });
      continue;
    }
    const candidate = candidateSet[0]!;
    const report = reportSet[0]!;
    try {
      if (candidate.expired !== false || report.expired !== false) {
        throw new Error(`batch artifacts for ${requestId} are expired or have no fixed retention state`);
      }
      const artifactId = positiveArtifactId(candidate.id, requestId);
      const reportId = positiveArtifactId(report.id, requestId);
      if (typeof candidate.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(candidate.digest)) {
        throw new Error(`prepared artifact for ${requestId} has an invalid digest`);
      }
      ready.push({ artifactDigest: candidate.digest, artifactId, reportId, requestId });
    } catch (error: unknown) {
      skipped.push({ reason: errorMessage(error), requestId });
    }
  }
  return { ready, skipped };
}

function collectArtifacts(
  artifacts: readonly unknown[],
  prefix: string,
  suffix: string,
): Map<string, Array<Record<string, unknown>>> {
  const collected = new Map<string, Array<Record<string, unknown>>>();
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || typeof artifact['name'] !== 'string') continue;
    if (!artifact['name'].startsWith(prefix) || !artifact['name'].endsWith(suffix)) continue;
    const requestId = artifact['name'].slice(prefix.length, -suffix.length);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(requestId)) throw new Error(`batch artifact has invalid request id ${requestId}`);
    const matches = collected.get(requestId) ?? [];
    matches.push(artifact);
    collected.set(requestId, matches);
  }
  return collected;
}

function positiveArtifactId(value: unknown, requestId: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`batch artifacts for ${requestId} have invalid ids`);
  }
  return value as number;
}
