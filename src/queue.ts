import type { OracleManifest } from './types.js';

export interface ApprovalPull {
  base: { ref: string };
  head: { ref: string; repo: { full_name: string } | null; sha: string };
  number: number;
}

export interface ApprovalQueueEntry {
  headRef: string;
  headSha: string;
  number: number;
  requestId: string;
}

export interface ApprovalQueueSelection {
  obsolete: ApprovalQueueEntry[];
  selected: ApprovalQueueEntry | null;
}

export function selectApprovalQueue(
  pulls: readonly ApprovalPull[],
  manifest: Readonly<OracleManifest>,
  repository: string,
  requestedPull?: number,
): ApprovalQueueSelection {
  const releasedRequests = new Set(manifest.sourceRequests.map((request) => request.id));
  const queue = pulls
    .filter(
      (pull) =>
        pull.base.ref === 'main' && pull.head.repo?.full_name === repository && pull.head.ref.startsWith('oracle/'),
    )
    .sort((left, right) => left.number - right.number)
    .map((pull) => ({
      headRef: pull.head.ref,
      headSha: pull.head.sha,
      number: pull.number,
      requestId: requestIdFromApprovalHead(pull.head.ref),
    }));
  const obsolete = queue.filter((pull) => releasedRequests.has(pull.requestId));
  const pending = queue.filter((pull) => !releasedRequests.has(pull.requestId));
  const selected = pending[0] ?? null;

  if (requestedPull !== undefined) {
    const requested = queue.find((pull) => pull.number === requestedPull);
    if (requested === undefined) throw new Error(`PR #${requestedPull} is not an open reference image approval`);
    if (!releasedRequests.has(requested.requestId) && requested.number !== selected?.number) {
      throw new Error(`PR #${requestedPull} is not next; refresh and merge #${selected?.number ?? '(none)'} first`);
    }
  }

  return { obsolete, selected };
}

function requestIdFromApprovalHead(head: string): string {
  const match = /^oracle\/([a-z0-9][a-z0-9-]*)-[1-9][0-9]*$/u.exec(head);
  if (match === null) throw new Error(`approval branch ${head} does not end in its workflow run id`);
  return match[1]!;
}
