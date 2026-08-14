import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export function hashBytes(value: NodeJS.ArrayBufferView | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function hashFile(path: string): Promise<string> {
  return hashBytes(await readFile(path));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${path}: ${errorMessage(error)}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${errorMessage(error)}`);
  }
}

export async function writeCanonicalJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, canonicalJson(value), 'utf8');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
