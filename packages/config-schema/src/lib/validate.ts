import type { ErrorObject } from 'ajv';
import { parse as parseYaml, YAMLParseError } from 'yaml';

import type { ShipkeepConfig } from '../gen/shipkeep-config.js';
import { validate as validateFn } from '../gen/validator.js';

/** One validation problem, located by a JSON pointer into the document. */
export interface ConfigIssue {
  /** JSON pointer of the offending value, for example `/run/port`. Empty string is the root. */
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly config: ShipkeepConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

// Keep YAML parsing strict and predictable: YAML 1.2 core schema (so `yes` stays a string),
// no duplicate keys, bounded aliases to defuse billion-laughs documents.
const YAML_OPTIONS = {
  version: '1.2',
  schema: 'core',
  uniqueKeys: true,
  maxAliasCount: 50,
  prettyErrors: false,
} as const;

/** Upper bound on a shipkeep.yml document, in bytes. */
export const MAX_CONFIG_BYTES = 256 * 1024;

/**
 * Validates an already parsed document against the shipkeep.yml schema.
 */
export function validateShipkeepConfig(value: unknown): ValidationResult {
  if (validateFn(value)) {
    return { ok: true, config: value as ShipkeepConfig };
  }
  return { ok: false, issues: toIssues(validateFn.errors ?? []) };
}

/**
 * Parses YAML text and validates it. Parse errors are reported as issues at the root.
 */
export function parseShipkeepConfig(text: string): ValidationResult {
  // TextEncoder, not Buffer: the web UI validates documents in the browser too.
  if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) {
    return {
      ok: false,
      issues: [{ path: '', message: `document exceeds ${String(MAX_CONFIG_BYTES)} bytes` }],
    };
  }
  let value: unknown;
  try {
    value = parseYaml(text, YAML_OPTIONS);
  } catch (error: unknown) {
    const message = error instanceof YAMLParseError ? error.message : 'invalid YAML';
    return { ok: false, issues: [{ path: '', message }] };
  }
  return validateShipkeepConfig(value);
}

function toIssues(errors: readonly ErrorObject[]): ConfigIssue[] {
  const seen = new Set<string>();
  const issues: ConfigIssue[] = [];
  for (const error of errors) {
    const detail =
      error.keyword === 'additionalProperties' &&
      typeof error.params['additionalProperty'] === 'string'
        ? `unknown key "${error.params['additionalProperty']}"`
        : (error.message ?? error.keyword);
    const key = `${error.instancePath}\u0000${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ path: error.instancePath, message: detail });
  }
  return issues;
}
