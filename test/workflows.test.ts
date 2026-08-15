import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

describe('GitHub Actions workflows', () => {
  for (const file of ['ci.yml', 'intake.yml', 'release.yml']) {
    it(`${file} is valid YAML`, async () => {
      const document = parseDocument(await readFile(join('.github', 'workflows', file), 'utf8'));
      expect(document.errors).toEqual([]);
      expect(document.toJS()).toHaveProperty('jobs');
    });
  }

  it('keeps image processing out of both privileged writers', async () => {
    const intake = parse(await readFile(join('.github', 'workflows', 'intake.yml'), 'utf8'));
    const release = parse(await readFile(join('.github', 'workflows', 'release.yml'), 'utf8'));

    expect(job(intake, 'prepare').permissions.contents).toBe('read');
    expect(job(intake, 'open-pr').permissions.contents).toBe('read');
    expect(job(release, 'rebuild').permissions.contents).toBe('read');
    expect(job(release, 'publish').permissions.contents).toBe('write');
    expect(JSON.stringify(job(intake, 'open-pr'))).not.toMatch(/intake:(prepare|replay)/u);
    expect(JSON.stringify(job(release, 'publish'))).not.toContain('intake:replay');
  });

  it('extracts id-selected artifacts directly into their consumer directories', async () => {
    for (const file of ['ci.yml', 'intake.yml', 'release.yml']) {
      const workflow = parse(await readFile(join('.github', 'workflows', file), 'utf8'));
      for (const definition of Object.values(workflow.jobs)) {
        for (const step of definition.steps ?? []) {
          if (step.uses !== 'actions/download-artifact@v4' || step.with?.['artifact-ids'] === undefined) continue;
          expect(step.with['merge-multiple'], `${file}: ${step.name ?? step.uses}`).toBe(true);
        }
      }
    }
  });
});

interface Workflow {
  jobs: Record<
    string,
    {
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
