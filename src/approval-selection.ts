import { canonicalJson, hashBytes } from './json.js';
import type { CandidateApproval, OracleRecord } from './types.js';

export interface DeferredApproval {
  reason: string;
  requestId: string;
  sha256: string;
}

export interface ApprovalSelection {
  deferred: DeferredApproval[];
  selected: CandidateApproval[];
}

export function selectPublishableApprovals(
  approvals: readonly CandidateApproval[],
  records: ReadonlyMap<string, OracleRecord>,
  reservedApprovals: readonly CandidateApproval[] = [],
): ApprovalSelection {
  const claimedPaths = new Map<string, string>();
  for (const approval of [...reservedApprovals].sort(compareApprovals)) {
    if (approvalBaseMismatch(approval, records) !== undefined) continue;
    for (const record of approval.records)
      if (!claimedPaths.has(record.path)) claimedPaths.set(record.path, approval.requestId);
  }

  const deferred: DeferredApproval[] = [];
  const selected: CandidateApproval[] = [];
  for (const approval of [...approvals].sort(compareApprovals)) {
    const stalePath = approvalBaseMismatch(approval, records);
    if (stalePath !== undefined) {
      deferred.push(deferApproval(approval, `review base no longer matches ${stalePath}`));
      continue;
    }
    const overlap = approval.records.find((record) => claimedPaths.has(record.path));
    if (overlap !== undefined) {
      deferred.push(
        deferApproval(approval, `overlaps ${overlap.path} claimed by request ${claimedPaths.get(overlap.path)!}`),
      );
      continue;
    }
    selected.push(approval);
    for (const record of approval.records) claimedPaths.set(record.path, approval.requestId);
  }
  return { deferred, selected };
}

export function approvalBaseMismatch(
  approval: Readonly<CandidateApproval>,
  records: ReadonlyMap<string, OracleRecord>,
): string | undefined {
  return approval.baseRecords.find(({ path, sha256 }) => {
    const record = records.get(path);
    const actual = record === undefined ? null : hashBytes(canonicalJson(record));
    return actual !== sha256;
  })?.path;
}

function compareApprovals(left: Readonly<CandidateApproval>, right: Readonly<CandidateApproval>): number {
  return left.requestId.localeCompare(right.requestId);
}

export function deferApproval(approval: Readonly<CandidateApproval>, reason: string): DeferredApproval {
  return {
    reason,
    requestId: approval.requestId,
    sha256: hashBytes(canonicalJson(approval)),
  };
}
