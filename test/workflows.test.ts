import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

const workflowFiles = [
  'ci.yml',
  'intake.yml',
  'intake-batch.yml',
  'migrate-approvals.yml',
  'release.yml',
  'stage-release.yml',
];

describe('GitHub Actions workflows', () => {
  for (const file of workflowFiles) {
    it(`${file} is valid YAML`, async () => {
      const document = parseDocument(await readFile(join('.github', 'workflows', file), 'utf8'));
      expect(document.errors).toEqual([]);
      expect(document.toJS()).toHaveProperty('jobs');
    });
  }

  it('keeps shell heredoc terminators unindented', async () => {
    for (const file of workflowFiles) {
      const workflow = parse(await readFile(join('.github', 'workflows', file), 'utf8'));
      for (const definition of Object.values(workflow.jobs)) {
        for (const step of definition.steps ?? []) {
          for (const match of step.run?.matchAll(/<<-?'([A-Z][A-Z0-9_]*)'/gu) ?? []) {
            expect(step.run?.split('\n'), `${file}: ${step.name ?? 'unnamed step'}`).toContain(match[1]);
          }
        }
      }
    }
  });

  it('keeps image processing out of privileged writers', async () => {
    const batch = parse(await readFile(join('.github', 'workflows', 'intake-batch.yml'), 'utf8'));
    const intake = parse(await readFile(join('.github', 'workflows', 'intake.yml'), 'utf8'));
    const release = parse(await readFile(join('.github', 'workflows', 'release.yml'), 'utf8'));
    const stage = parse(await readFile(join('.github', 'workflows', 'stage-release.yml'), 'utf8'));

    expect(job(batch, 'open-batch-pr').permissions.contents).toBe('read');
    expect(job(intake, 'prepare').permissions.contents).toBe('read');
    expect(job(intake, 'open-pr').permissions.contents).toBe('read');
    expect(job(release, 'rebuild').permissions.contents).toBe('read');
    expect(job(release, 'publish').permissions.contents).toBe('write');
    expect(job(stage, 'prepare').permissions.contents).toBe('read');
    expect(job(stage, 'open-pr').permissions.contents).toBe('read');
    expect(JSON.stringify(job(batch, 'open-batch-pr'))).not.toMatch(/intake:(prepare|replay)/u);
    expect(JSON.stringify(job(intake, 'open-pr'))).not.toMatch(/intake:(prepare|replay)/u);
    expect(JSON.stringify(job(release, 'publish'))).not.toContain('intake:replay');
  });

  it('extracts id-selected artifacts directly into their consumer directories', async () => {
    for (const file of workflowFiles) {
      const workflow = parse(await readFile(join('.github', 'workflows', file), 'utf8'));
      for (const definition of Object.values(workflow.jobs)) {
        for (const step of definition.steps ?? []) {
          if (step.uses !== 'actions/download-artifact@v4' || step.with?.['artifact-ids'] === undefined) continue;
          expect(step.with['merge-multiple'], `${file}: ${step.name ?? step.uses}`).toBe(true);
        }
      }
    }
  });

  it('allows release publication to catch up before failing pack downloads', async () => {
    for (const file of ['ci.yml', 'intake.yml', 'intake-batch.yml', 'release.yml', 'stage-release.yml']) {
      const workflow = parse(await readFile(join('.github', 'workflows', file), 'utf8'));
      const downloads = Object.values(workflow.jobs)
        .flatMap((definition) => definition.steps ?? [])
        .filter((step) => step.run?.includes('packs:download') || step.run?.includes('release:readiness'));
      expect(downloads.length).toBeGreaterThan(0);
      for (const step of downloads) {
        expect(step.run).toContain('--attempts 60');
        expect(step.run).toContain('--retry-delay-ms 10000');
      }
    }
  });

  it('gates batch fan-out on one actionable current-release readiness check', async () => {
    const batchText = await readFile(join('.github', 'workflows', 'intake-batch.yml'), 'utf8');
    const batch = parse(batchText);
    const readiness = job(batch, 'release-ready');

    expect(readiness.needs).toBe('validate');
    expect(readiness.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(readiness.steps?.filter((step) => step.run?.includes('release:readiness'))).toHaveLength(1);
    expect(batchText).toContain('Current blessed release is unavailable');
    expect(batchText).toContain('[Open Release blessed reference images](${workflow_url})');
    expect(job(batch, 'intake').needs).toEqual(['validate', 'release-ready']);
  });

  it('qualifies upload-action digests before durable use or API comparison', async () => {
    const intake = parse(await readFile(join('.github', 'workflows', 'intake.yml'), 'utf8'));
    const release = parse(await readFile(join('.github', 'workflows', 'release.yml'), 'utf8'));
    const stage = parse(await readFile(join('.github', 'workflows', 'stage-release.yml'), 'utf8'));
    const qualifiedDigest = 'sha256:${{ steps.upload.outputs.artifact-digest }}';

    expect(job(intake, 'prepare').outputs?.['artifact-digest']).toBe(qualifiedDigest);
    expect(job(release, 'rebuild').outputs?.['artifact-digest']).toBe(qualifiedDigest);
    expect(job(stage, 'prepare').outputs?.['artifact-digest']).toBe(qualifiedDigest);
  });

  it('targets the renamed repository and Flight lock path', async () => {
    const intakeText = await readFile(join('.github', 'workflows', 'intake.yml'), 'utf8');
    const intake = parse(intakeText);
    const batchIntake = parse(await readFile(join('.github', 'workflows', 'intake-batch.yml'), 'utf8'));
    const releaseText = await readFile(join('.github', 'workflows', 'release.yml'), 'utf8');

    expect(intake.on?.repository_dispatch?.types).toEqual(['flight-reference-image-candidate']);
    expect(batchIntake.on?.repository_dispatch?.types).toEqual(['flight-reference-image-candidate-batch']);
    expect(intakeText).toContain('repositories: flight-reference-images');
    expect(releaseText).toContain('scripts/reference-image-lock.json');
    expect(`${intakeText}\n${releaseText}`).not.toContain('flight-oracles');
    expect(releaseText).not.toContain('scripts/oracle-lock.json');
  });

  it('publishes only when the immutable release manifest changes', async () => {
    const release = parse(await readFile(join('.github', 'workflows', 'release.yml'), 'utf8'));

    expect(release.on?.push?.paths).toEqual(['manifest.json']);
  });

  it('reconstructs one Flight lock PR from its current base instead of replaying conflicting deletions', async () => {
    const releaseText = await readFile(join('.github', 'workflows', 'release.yml'), 'utf8');

    expect(releaseText).toContain("pull.head.ref.startsWith('reference-image-lock/')");
    expect(releaseText).toContain('if [ "${EXISTING}" = \'true\' ]');
    expect(releaseText).toContain("ref: ${{ vars.FLIGHT_BASE_BRANCH || 'develop' }}");
    expect(releaseText).toContain('npm run flight:reconcile');
    expect(releaseText).toContain('git add -A -- scripts/reference-image-lock.json reference-image-requests');
    expect(releaseText).not.toContain('git rebase');
    expect(releaseText).toContain('--force-with-lease="refs/heads/${branch}:${EXPECTED_HEAD_SHA}"');
    expect(releaseText).toContain('gh pr edit "${PR_NUMBER}"');
  });

  it('retries completion only after verifying an existing immutable release', async () => {
    const releaseText = await readFile(join('.github', 'workflows', 'release.yml'), 'utf8');

    expect(releaseText).toContain('gh release download "${RELEASE_TAG}"');
    expect(releaseText).toContain('existing release asset ${file} differs');
    expect(releaseText).toContain('oracle_commit=${object_sha}');
    expect(releaseText).toContain('ORACLE_COMMIT: ${{ needs.publish.outputs.oracle-commit }}');
  });

  it('opens independently mergeable approval-only PRs', async () => {
    const intakeText = await readFile(join('.github', 'workflows', 'intake.yml'), 'utf8');
    const intake = parse(intakeText);

    expect(intake.concurrency).toBeUndefined();
    expect(intakeText).toContain('intake:approve');
    expect(intakeText).toContain('git add "${approval_path}"');
    expect(intakeText).toContain('stable_branch="approval/${REQUEST_ID}"');
    expect(intakeText).toContain('test("^" + $stable + "-[0-9]+$")');
    expect(intakeText).not.toContain('startswith($stable + "-")');
    expect(intakeText).toContain('--force-with-lease="refs/heads/${branch}:${expected}"');
    expect(intakeText).toContain('gh pr edit "${pull_request}"');
    expect(intakeText).not.toContain('create_options+=(--draft)');
    expect(intakeText).not.toContain('git add manifest.json oracles candidates');
    for (const name of ['prepare', 'open-pr']) {
      expect(job(intake, name).steps?.find((step) => step.uses === 'actions/checkout@v4')?.with?.ref).toBe('main');
    }
  });

  it('fans one complete v2 dispatch into bounded independent v1 intake calls', async () => {
    const batchText = await readFile(join('.github', 'workflows', 'intake-batch.yml'), 'utf8');
    const batch = parse(batchText);
    const intake = parse(await readFile(join('.github', 'workflows', 'intake.yml'), 'utf8'));
    const intakeJob = job(batch, 'intake');

    expect(batchText).toContain('npm run schema:check -- --schema dispatch-batch');
    expect(batchText).toContain('npm run --silent dispatch:expand');
    expect(intakeJob.strategy).toMatchObject({ 'fail-fast': false, 'max-parallel': 12 });
    expect(intakeJob.uses).toBe('./.github/workflows/intake.yml');
    expect(JSON.stringify(intakeJob.with)).toContain('matrix.candidate.artifactDigest');
    expect(intakeJob.with?.['approval_mode']).toBe('batch');
    expect(intake.on?.workflow_call?.inputs?.artifact_id).toMatchObject({ required: true, type: 'number' });
    expect(intake.on?.workflow_call?.inputs?.approval_mode).toMatchObject({ required: false, type: 'string' });
    expect(job(intake, 'open-pr').if).toBe("inputs.approval_mode != 'batch'");
    expect(intake.on?.workflow_call?.secrets).toEqual({
      ORACLE_APP_ID: { required: true },
      ORACLE_APP_PRIVATE_KEY: { required: true },
    });
  });

  it('opens one atomic approval PR for a complete successful batch', async () => {
    const batchText = await readFile(join('.github', 'workflows', 'intake-batch.yml'), 'utf8');
    const batch = parse(batchText);
    const writer = job(batch, 'open-batch-pr');

    expect(writer.needs).toEqual(['validate', 'intake']);
    expect(writer.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(batchText).toContain('npm run --silent batch:approval-artifacts');
    expect(batchText).toContain('npm run intake:approve');
    expect(batchText).toContain('refusing a partial batch approval PR');
    expect(batchText).toContain('stable_branch="approval-batch/${SOURCE_RUN_ID}"');
    expect(batchText.match(/gh pr create/gu)).toHaveLength(1);
    expect(batchText).toContain('Merging blesses every approval record in this PR');
  });

  it('accumulates merged approvals into one deterministic publication PR', async () => {
    const stageText = await readFile(join('.github', 'workflows', 'stage-release.yml'), 'utf8');
    const stage = parse(stageText);

    expect(stage.on?.push?.paths).toEqual(['approvals/*.json']);
    expect(stageText).toContain('npm run batch:prepare');
    expect(stageText).toContain('npm run batch:apply');
    expect(stageText).toMatch(/startswith\(['"]publication\/['"]\)/u);
    expect(stageText).toContain('--force-with-lease=');
    expect(stage.concurrency).toEqual({ group: 'oracle-batch-stage', 'cancel-in-progress': true });
  });

  it('migrates only still-legacy approval PRs to independent records', async () => {
    const migrationText = await readFile(join('.github', 'workflows', 'migrate-approvals.yml'), 'utf8');
    const migration = parse(migrationText);

    expect(migration.on?.push?.paths).toContain('schemas/approval.schema.json');
    expect(migrationText).toContain('/^candidates\\/.+\\.json$/u');
    expect(migrationText).toContain('npm run intake:approve');
    expect(migrationText).toContain('git add "approvals/${REQUEST_ID}.json"');
    expect(migrationText).toContain('--force-with-lease=');
    expect(migrationText).not.toContain('npm run intake:apply');
  });

  it('derives readable approval labels without changing request identity', async () => {
    const intakeText = await readFile(join('.github', 'workflows', 'intake.yml'), 'utf8');
    const requestSchema = JSON.parse(await readFile(join('schemas', 'request.schema.json'), 'utf8')) as {
      properties: Record<string, unknown>;
    };

    expect(intakeText).toContain('approval:label');
    expect(intakeText).toContain('approval:summary');
    expect(intakeText).toContain('REQUEST_LABEL');
    expect(intakeText).toContain('GITHUB_STEP_SUMMARY');
    expect(requestSchema.properties).not.toHaveProperty('label');
  });
});

interface Workflow {
  on?: {
    push?: { paths?: string[] };
    repository_dispatch?: { types?: string[] };
    workflow_call?: {
      inputs?: Record<string, { required?: boolean; type?: string }>;
      secrets?: Record<string, { required?: boolean }>;
    };
    workflow_dispatch?: {
      inputs?: Record<string, { required?: boolean }>;
    };
    workflow_run?: { branches?: string[]; types?: string[]; workflows?: string[] };
  };
  concurrency?: { 'cancel-in-progress'?: boolean; group?: string };
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string | string[];
      outputs?: Record<string, unknown>;
      permissions: Record<string, string>;
      strategy?: Record<string, unknown>;
      steps?: { name?: string; run?: string; uses?: string; with?: Record<string, unknown> }[];
      uses?: string;
      with?: Record<string, unknown>;
    }
  >;
}

function parse(text: string): Workflow {
  const document = parseDocument(text);
  if (document.errors.length > 0) throw document.errors[0];
  return document.toJS() as Workflow;
}

function job(workflow: Readonly<Workflow>, name: string): Workflow['jobs'][string] {
  const value = workflow.jobs[name];
  if (value === undefined) throw new Error(`workflow does not define job ${name}`);
  return value;
}
