import type { FlightOracleRequest } from './types.js';

export interface ApprovalSummaryOptions {
  releaseTag: string;
  reportUrl: string;
  request: Readonly<FlightOracleRequest>;
}

export function requestDisplayLabel(request: Readonly<FlightOracleRequest>): string {
  const entries = [...new Set(request.targets.map((target) => target.entry))];
  if (entries.length === 0) throw new Error('request has no targets');
  return entries.length === 1 ? entries[0]! : `${entries[0]} + ${entries.length - 1} more`;
}

export function renderApprovalSummary(options: Readonly<ApprovalSummaryOptions>): string {
  const { releaseTag, reportUrl, request } = options;
  const label = requestDisplayLabel(request);
  const dirtyTargets = request.targets.filter(
    (target) => target.build.dirty.length > 0 || target.build.dirtyOmitted > 0,
  ).length;
  const rows = request.targets
    .map(
      (target) =>
        `| \`${target.entry}\` | \`${target.renderer}\` | \`${abbreviate(target.pixelSha256)}\` | \`${abbreviate(target.build.commit)}\` |`,
    )
    .join('\n');
  const dirtyWarning =
    dirtyTargets === 0
      ? ''
      : `\n> **Build warning:** ${dirtyTargets} cell${dirtyTargets === 1 ? '' : 's'} came from a build with recorded dirty paths.\n`;

  return `## Reference image approval: ${label}

- Request: \`${request.id}\`
- Prospective release: \`${releaseTag}\`
- Cells: ${request.targets.length}
${dirtyWarning}
| Entry | Renderer | Reviewed pixels | Flight build |
| --- | --- | --- | --- |
${rows}

[Open the visual old/new/delta review artifact](${reportUrl}).

Merging the approval PR blesses the exact candidate bytes. The display label is derived from target entries; the request UUID remains the identity.
`;
}

function abbreviate(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}
