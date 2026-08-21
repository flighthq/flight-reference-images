import { execFileSync } from 'node:child_process';

import { errorMessage, isRecord } from './json.js';
import { downloadReleasePacks } from './pack.js';
import type { OracleManifest } from './types.js';

export interface CurrentReleaseReadinessOptions {
  attempts: number;
  branch?: string;
  manifest: Readonly<OracleManifest>;
  outputDirectory: string;
  repository: string;
  repositoryRoot: string;
  retryDelayMilliseconds: number;
}

interface WorkflowRun {
  conclusion: string | null;
  headSha: string;
  status: string;
  url: string;
}

export async function requireCurrentRelease(options: Readonly<CurrentReleaseReadinessOptions>): Promise<void> {
  const branch = options.branch ?? 'main';
  const releaseTag = options.manifest.releaseTag;
  const token = process.env['GH_TOKEN'];

  if (releaseTag !== null && token !== undefined && token.length > 0) {
    try {
      const releaseExists = await publishedReleaseExists(options.repository, releaseTag, token);
      if (releaseExists === false) {
        const run = await latestReleaseWorkflowRun(options.repository, branch, token);
        if (
          run !== undefined &&
          run.status === 'completed' &&
          run.conclusion !== null &&
          run.conclusion !== 'success' &&
          isManifestAncestor(options.repositoryRoot, run.headSha)
        ) {
          throw new ReleaseWorkflowFailedError(
            `manifest.json names unpublished release ${releaseTag}, and its latest release workflow failed: ${run.url}. ${recoveryInstruction(options.repository, branch)}`,
          );
        }
      }
    } catch (error) {
      if (error instanceof ReleaseWorkflowFailedError) throw error;
      console.warn(`cannot inspect release workflow status: ${errorMessage(error)}; using the bounded pack wait`);
    }
  }

  try {
    await downloadReleasePacks(options.manifest, options.repository, options.outputDirectory, {
      attempts: options.attempts,
      retryDelayMilliseconds: options.retryDelayMilliseconds,
    });
  } catch (error) {
    throw new Error(
      `current manifest release ${releaseTag ?? '(bootstrap)'} did not pass readiness: ${errorMessage(error)}. ${recoveryInstruction(options.repository, branch)}`,
    );
  }
}

class ReleaseWorkflowFailedError extends Error {}

async function publishedReleaseExists(
  repository: string,
  releaseTag: string,
  token: string,
): Promise<boolean | undefined> {
  const response = await fetch(
    `https://api.github.com/repos/${repositoryPath(repository)}/releases/tags/${encodeURIComponent(releaseTag)}`,
    { headers: githubHeaders(token) },
  );
  if (response.ok) return true;
  return response.status === 404 ? false : undefined;
}

async function latestReleaseWorkflowRun(
  repository: string,
  branch: string,
  token: string,
): Promise<WorkflowRun | undefined> {
  const query = new URLSearchParams({ branch, per_page: '1' });
  const response = await fetch(
    `https://api.github.com/repos/${repositoryPath(repository)}/actions/workflows/release.yml/runs?${query}`,
    { headers: githubHeaders(token) },
  );
  if (!response.ok) return undefined;
  const value: unknown = await response.json();
  if (!isRecord(value) || !Array.isArray(value['workflow_runs'])) return undefined;
  const run: unknown = value['workflow_runs'][0];
  if (
    !isRecord(run) ||
    typeof run['head_sha'] !== 'string' ||
    typeof run['status'] !== 'string' ||
    (run['conclusion'] !== null && typeof run['conclusion'] !== 'string') ||
    typeof run['html_url'] !== 'string'
  ) {
    return undefined;
  }
  return {
    conclusion: run['conclusion'],
    headSha: run['head_sha'],
    status: run['status'],
    url: run['html_url'],
  };
}

function isManifestAncestor(repositoryRoot: string, runHeadSha: string): boolean {
  try {
    const manifestCommit = execFileSync('git', ['log', '-1', '--format=%H', '--', 'manifest.json'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
    if (manifestCommit.length === 0) return false;
    execFileSync('git', ['merge-base', '--is-ancestor', manifestCommit, runHeadSha], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function repositoryPath(repository: string): string {
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[a-z0-9_.-]+$/iu.test(part))) {
    throw new Error(`invalid GitHub repository ${repository}`);
  }
  return parts.map((part) => encodeURIComponent(part)).join('/');
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'flight-reference-images',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function recoveryInstruction(repository: string, branch: string): string {
  return `Inspect or run Release blessed reference images from current ${branch}: https://github.com/${repository}/actions/workflows/release.yml. Do not rerun a historical failed release job or the batch until the release is ready.`;
}
