import { readdir } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';

import type { OracleIdentity, PackConfiguration } from './types.js';

export function assertSafeRelativePath(path: string): void {
  if (path === '' || path.startsWith('/') || path.includes('\\')) {
    throw new Error(`unsafe relative path: ${path}`);
  }
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`unsafe relative path: ${path}`);
  }
}

export function identityKey(identity: Readonly<OracleIdentity>): string {
  return `${identity.subject}/${identity.entry}/${identity.renderer}`;
}

export function imagePath(identity: Readonly<OracleIdentity>): string {
  return `images/${identityKey(identity)}.png`;
}

export function oracleRecordPath(identity: Readonly<OracleIdentity>): string {
  return `oracles/${identityKey(identity)}.json`;
}

export function resolveInside(root: string, path: string): string {
  assertSafeRelativePath(path);
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`path escapes ${root}: ${path}`);
  }
  return resolvedPath;
}

export function resolvePack(identity: Readonly<OracleIdentity>, config: Readonly<PackConfiguration>): string {
  const subject = config.subjects[identity.subject];
  if (subject === undefined) throw new Error(`no pack configuration for subject ${identity.subject}`);

  for (const rule of subject.rules ?? []) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(rule.entryPattern, 'u');
    } catch (error) {
      throw new Error(
        `invalid pack rule ${rule.entryPattern}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (pattern.test(identity.entry)) return rule.pack;
  }
  return subject.defaultPack;
}

export async function findFiles(root: string, suffix?: string): Promise<string[]> {
  const files: string[] = [];
  await visit(root, '');
  return files.sort();

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath, relativePath);
      else if (entry.isFile() && (suffix === undefined || relativePath.endsWith(suffix))) files.push(relativePath);
    }
  }
}

export async function findNonRegularEntries(root: string): Promise<string[]> {
  const entries: string[] = [];
  await visit(root, '');
  return entries.sort();

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const relativePath = relativeDirectory === '' ? child.name : `${relativeDirectory}/${child.name}`;
      if (child.isDirectory()) await visit(join(directory, child.name), relativePath);
      else if (!child.isFile()) entries.push(relativePath);
    }
  }
}

export function relativePosix(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
