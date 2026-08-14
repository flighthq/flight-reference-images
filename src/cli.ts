#!/usr/bin/env node

import { resolve } from 'node:path';

import { applyPreparedIntake, prepareIntake, replayPreparedIntake } from './intake.js';
import { errorMessage } from './json.js';
import { downloadReleasePacks, verifyReleasePacks } from './pack.js';
import { readRepository } from './repository.js';

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === 'check') {
    const root = resolve(option(arguments_, '--root') ?? '.');
    const state = await readRepository(root);
    console.log(
      `repository valid: ${state.records.size} oracle records, ${state.manifest.packs.length} packs, ${state.policies.size} policies`,
    );
    return;
  }

  if (command === 'packs-download') {
    const root = resolve(option(arguments_, '--root') ?? '.');
    const output = resolve(requiredOption(arguments_, '--output'));
    const repository = option(arguments_, '--repository') ?? 'flighthq/flight-oracles';
    const state = await readRepository(root);
    await downloadReleasePacks(state.manifest, repository, output);
    console.log(`downloaded and verified ${state.manifest.packs.length} packs in ${output}`);
    return;
  }

  if (command === 'intake-prepare') {
    const prepared = await prepareIntake({
      candidateDirectory: requiredOption(arguments_, '--candidate'),
      envelopePath: requiredOption(arguments_, '--envelope'),
      outputDirectory: requiredOption(arguments_, '--output'),
      previousPackDirectory: requiredOption(arguments_, '--previous-packs'),
      repositoryRoot: option(arguments_, '--root') ?? '.',
      requestPath: requiredOption(arguments_, '--request'),
    });
    console.log(JSON.stringify(prepared));
    return;
  }

  if (command === 'intake-apply') {
    const locator = await applyPreparedIntake({
      artifactDigest: requiredOption(arguments_, '--artifact-digest'),
      artifactId: positiveIntegerOption(arguments_, '--artifact-id'),
      preparedDirectory: requiredOption(arguments_, '--prepared'),
      repositoryRoot: option(arguments_, '--root') ?? '.',
      workflowRunId: positiveIntegerOption(arguments_, '--workflow-run-id'),
    });
    console.log(JSON.stringify(locator));
    return;
  }

  if (command === 'intake-replay') {
    const prepared = await replayPreparedIntake({
      outputDirectory: requiredOption(arguments_, '--output'),
      preparedDirectory: requiredOption(arguments_, '--prepared'),
      previousPackDirectory: requiredOption(arguments_, '--previous-packs'),
      repositoryRoot: option(arguments_, '--root') ?? '.',
    });
    console.log(JSON.stringify(prepared));
    return;
  }

  if (command === 'release-verify') {
    const root = resolve(option(arguments_, '--root') ?? '.');
    const packs = resolve(requiredOption(arguments_, '--packs'));
    const state = await readRepository(root);
    await verifyReleasePacks(state.manifest, state.records, packs);
    console.log(`release valid: ${state.records.size} images in ${state.manifest.packs.length} packs`);
    return;
  }

  throw new Error(`unknown command ${command ?? '(none)'}`);
}

function positiveIntegerOption(arguments_: readonly string[], name: string): number {
  const text = requiredOption(arguments_, name);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got ${text}`);
  return value;
}

function requiredOption(arguments_: readonly string[], name: string): string {
  const value = option(arguments_, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

main().catch((error: unknown) => {
  console.error(`flight-oracles: ${errorMessage(error)}`);
  process.exitCode = 1;
});
