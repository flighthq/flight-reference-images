#!/usr/bin/env node

import { resolve } from 'node:path';

import { errorMessage } from './json.js';
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

  throw new Error(`unknown command ${command ?? '(none)'}`);
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
