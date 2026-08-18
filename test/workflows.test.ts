import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

describe('GitHub Actions workflows', () => {
  for (const file of ['ci.yml', 'intake.yml', 'refresh-candidate.yml', 'release.yml']) {
    it(`${file} is valid YAML`, async () => {
      const document = parseDocument(await readFile(join('.github', 'workflows', file), 'utf8'));
      expect(document.errors).toEqual([]);
      expect(document.toJS()).toHaveProperty('jobs');
    });
  }

  it('keeps image processing out of both privileged writers', async () => {
    const intake = parse(await readFile(join('.github', 'workflows', 'intake.yml'), 'utf8'));
    const refresh = parse(await readFile(join('.github', 'workflows', 'refresh-candidate.yml'), 'utf8'));
    const release = parse(await readFile(join('.github', 'workflows', 'release.yml'), 'utf8'));

    expect(job(intake, 'prepare').permissions.contents).toBe('read');
    expect(job(intake, 'open-pr').permissions.contents).toBe('read');
    expect(job(refresh, 'prepare').permissions.contents).toBe('read');
    expect(job(refresh, 'update-pr').permissions.contents).toBe('read');
    expect(job(release, 'rebuild').permissions.contents).toBe('read');
    expect(job(release, 'publish').permissions.contents).toBe('write');
    expect(JSON.stringify(job(intake, 'open-pr'))).not.toMatch(/intake:(prepare|replay)/u);
    expect(JSON.stringify(job(refresh, 'prepare'))).not.toContain('intake:apply');
    expect(JSON.stringify(job(refresh, 'update-pr'))).not.toMatch(/intake:(prepare|replay)/u);
    expect(JSON.stringify(job(release, 'publish'))).not.toContain('intake:replay');
  });

  it('extracts id-selected artifacts directly into their consumer directories', async () => {
    for (const file of ['ci.yml', 'intake.yml', 'refresh-candidate.yml', 'release.yml']) {
      const workflow = parse(await readFile(join('.github', 'workflows', file), 'utf8'));
      for (const definition of Object.values(workflow.jobs)) {
        for (const step of definition.steps ?? []) {
          if (step.uses !== 'actions/download-artifact@v4' || step.with?.['artifact-ids'] === undefined) continue;
          expect(step.with['merge-multiple'], `${file}: ${step.name ?? step.uses}`).toBe(true);
        }
      }
    }
  });

  it('qualifies upload-action digests before durable use or API comparison', async () => {
    const intake = parse(await readFile(join('.github', 'workflows', 'intake.yml'), 'utf8'));
    const refresh = parse(await readFile(join('.github', 'workflows', 'refresh-candidate.yml'), 'utf8'));
    const release = parse(await readFile(join('.github', 'workflows', 'release.yml'), 'utf8'));
    const qualifiedDigest = 'sha256:${{ steps.upload.outputs.artifact-digest }}';

    expect(job(intake, 'prepare').outputs?.['artifact-digest']).toBe(qualifiedDigest);
    expect(job(refresh, 'prepare').outputs?.['artifact-digest']).toBe(qualifiedDigest);
    expect(job(release, 'rebuild').outputs?.['artifact-digest']).toBe(qualifiedDigest);
  });

  it('targets the renamed repository and Flight lock path', async () => {
    const intakeText = await readFile(join('.github', 'workflows', 'intake.yml'), 'utf8');
    const intake = parse(intakeText);
    const releaseText = await readFile(join('.github', 'workflows', 'release.yml'), 'utf8');

    expect(intake.on?.repository_dispatch?.types).toEqual(['flight-reference-image-candidate']);
    expect(intakeText).toContain('repositories: flight-reference-images');
    expect(releaseText).toContain('scripts/reference-image-lock.json');
    expect(`${intakeText}\n${releaseText}`).not.toContain('flight-oracles');
    expect(releaseText).not.toContain('scripts/oracle-lock.json');
  });

  it('publishes only when the immutable release manifest changes', async () => {
    const release = parse(await readFile(join('.github', 'workflows', 'release.yml'), 'utf8'));

    expect(release.on?.push?.paths).toEqual(['manifest.json']);
  });

  it('advances one Flight lock PR instead of opening conflicting siblings', async () => {
    const releaseText = await readFile(join('.github', 'workflows', 'release.yml'), 'utf8');

    expect(releaseText).toContain("pull.head.ref.startsWith('reference-image-lock/')");
    expect(releaseText).toContain('if [ "${EXISTING}" = \'true\' ]');
    expect(releaseText).toContain('gh pr edit "${PR_NUMBER}"');
  });

  it('serializes intake and queues later approvals as drafts', async () => {
    const intakeText = await readFile(join('.github', 'workflows', 'intake.yml'), 'utf8');
    const intake = parse(intakeText);

    expect(intake.concurrency?.group).toBe('oracle-intake');
    expect(intake.concurrency?.['cancel-in-progress']).toBe(false);
    expect(intakeText).toContain('create_options+=(--draft)');
    for (const name of ['prepare', 'open-pr']) {
      expect(job(intake, name).steps?.find((step) => step.uses === 'actions/checkout@v4')?.with?.ref).toBe('main');
    }
  });

  it('automatically advances the oldest queued approval after a successful release', async () => {
    const refreshText = await readFile(join('.github', 'workflows', 'refresh-candidate.yml'), 'utf8');
    const refresh = parse(refreshText);

    expect(refresh.on?.workflow_run).toEqual({
      branches: ['main'],
      types: ['completed'],
      workflows: ['Release blessed reference images'],
    });
    expect(refresh.on?.workflow_dispatch?.inputs?.pull_request?.required).toBe(false);
    expect(job(refresh, 'prepare').if).toContain("workflow_run.conclusion == 'success'");
    expect(job(refresh, 'prepare').outputs?.found).toBe('${{ steps.pull.outputs.found }}');
    expect(job(refresh, 'update-pr').if).toBe("needs.prepare.outputs.found == 'true'");
    expect(refreshText).toContain('PR_NUMBER: ${{ needs.prepare.outputs.pull-request }}');
  });

  it('derives readable approval labels without changing request identity', async () => {
    const intakeText = await readFile(join('.github', 'workflows', 'intake.yml'), 'utf8');
    const refreshText = await readFile(join('.github', 'workflows', 'refresh-candidate.yml'), 'utf8');
    const requestSchema = JSON.parse(await readFile(join('schemas', 'request.schema.json'), 'utf8')) as {
      properties: Record<string, unknown>;
    };

    for (const workflow of [intakeText, refreshText]) {
      expect(workflow).toContain('approval:label');
      expect(workflow).toContain('approval:summary');
      expect(workflow).toContain('REQUEST_LABEL');
      expect(workflow).toContain('GITHUB_STEP_SUMMARY');
    }
    expect(requestSchema.properties).not.toHaveProperty('label');
  });
});

interface Workflow {
  on?: {
    push?: { paths?: string[] };
    repository_dispatch?: { types?: string[] };
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
      outputs?: Record<string, unknown>;
      permissions: Record<string, string>;
      steps?: { name?: string; uses?: string; with?: Record<string, unknown> }[];
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
