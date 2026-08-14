import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson } from './json.js';
import type { BitmapMismatch } from './png.js';
import type { OracleIdentity } from './types.js';

export interface ReviewRow {
  assets: {
    delta?: string;
    new?: string;
    old?: string;
  };
  identity: OracleIdentity;
  mismatch?: BitmapMismatch;
  note?: string;
  status: 'added' | 'changed' | 'dimension-changed' | 'missing' | 'unchanged';
  withinPolicy?: boolean;
}

export async function writeReviewReport(rows: readonly ReviewRow[], outputDirectory: string): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const sorted = [...rows].sort(compareRows);
  await writeFile(join(outputDirectory, 'report.json'), canonicalJson({ rows: sorted, schemaVersion: 1 }));
  await writeFile(join(outputDirectory, 'index.html'), renderHtml(sorted), 'utf8');
}

function compareRows(left: Readonly<ReviewRow>, right: Readonly<ReviewRow>): number {
  const leftMagnitude =
    left.mismatch?.fraction ?? (left.status === 'dimension-changed' || left.status === 'missing' ? 1 : -1);
  const rightMagnitude =
    right.mismatch?.fraction ?? (right.status === 'dimension-changed' || right.status === 'missing' ? 1 : -1);
  return rightMagnitude - leftMagnitude || identityLabel(left.identity).localeCompare(identityLabel(right.identity));
}

function identityLabel(identity: Readonly<OracleIdentity>): string {
  return `${identity.subject}/${identity.entry}/${identity.renderer}`;
}

function renderHtml(rows: readonly ReviewRow[]): string {
  const body = rows
    .map((row) => {
      const mismatch =
        row.mismatch === undefined
          ? escapeHtml(row.note ?? '—')
          : `${(row.mismatch.fraction * 100).toFixed(6)}% (${row.mismatch.mismatchedPixels.toLocaleString('en-US')} / ${row.mismatch.totalPixels.toLocaleString('en-US')}), max channel Δ ${row.mismatch.maxChannelDelta}${row.withinPolicy === undefined ? '' : row.withinPolicy ? ', within policy' : ', exceeds policy'}`;
      return `<section class="row status-${row.status}">
  <h2>${escapeHtml(identityLabel(row.identity))}</h2>
  <p><strong>${escapeHtml(row.status)}</strong> · ${mismatch}</p>
  <div class="images">${renderImage('Old', row.assets.old)}${renderImage('New', row.assets.new)}${renderImage('Delta', row.assets.delta)}</div>
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Flight oracle review</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 2rem; }
    .row { border-top: 3px solid #888; margin-top: 2rem; padding-top: 1rem; }
    .status-missing, .status-dimension-changed { border-color: #d33; }
    .status-changed { border-color: #d90; }
    .status-added { border-color: #39c; }
    .images { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
    figure { margin: 0; }
    img { background: repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 50% / 16px 16px; image-rendering: pixelated; max-width: 100%; }
    .absent { align-items: center; border: 1px dashed #888; display: flex; min-height: 10rem; justify-content: center; }
  </style>
</head>
<body>
  <h1>Flight oracle review</h1>
  <p>${rows.length} requested reference image${rows.length === 1 ? '' : 's'}, sorted by mismatch magnitude.</p>
  ${body}
</body>
</html>
`;
}

function renderImage(label: string, path: string | undefined): string {
  if (path === undefined)
    return `<figure><figcaption>${label}</figcaption><div class="absent">not available</div></figure>`;
  return `<figure><figcaption>${label}</figcaption><img src="${escapeHtml(path)}" alt="${label} reference"></figure>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
