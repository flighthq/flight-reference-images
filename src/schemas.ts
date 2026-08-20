import { readFileSync } from 'node:fs';

import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

export type SchemaName =
  | 'approval'
  | 'candidate'
  | 'candidate-locator'
  | 'comparison-policy'
  | 'dispatch-batch'
  | 'dispatch-envelope'
  | 'environment'
  | 'intake-policy'
  | 'manifest'
  | 'reference-image-lock'
  | 'oracle-record'
  | 'pack-manifest'
  | 'pack-config'
  | 'prepared-intake'
  | 'prepared-batch'
  | 'request'
  | 'request-image-differences';

const schemaNames: readonly SchemaName[] = [
  'approval',
  'candidate',
  'candidate-locator',
  'comparison-policy',
  'dispatch-batch',
  'dispatch-envelope',
  'environment',
  'intake-policy',
  'manifest',
  'reference-image-lock',
  'oracle-record',
  'pack-manifest',
  'pack-config',
  'prepared-intake',
  'prepared-batch',
  'request',
  'request-image-differences',
];

const ajv = new Ajv2020({ allErrors: true, strict: true });

const commonSchema = loadSchema('common');
ajv.addSchema(commonSchema);

const validators = new Map<SchemaName, ValidateFunction>();
for (const name of schemaNames) validators.set(name, ajv.compile(loadSchema(name)));

export function assertSchema<T>(name: SchemaName, value: unknown, label: string = name): asserts value is T {
  const validate = validators.get(name);
  if (validate === undefined) throw new Error(`schema not registered: ${name}`);
  if (!validate(value)) throw new Error(`${label} is invalid:\n${formatErrors(validate.errors)}`);
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `  ${error.instancePath === '' ? '/' : error.instancePath} ${error.message ?? 'is invalid'}`)
    .join('\n');
}

function loadSchema(name: string): AnySchema {
  const url = new URL(`../schemas/${name}.schema.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as AnySchema;
}
