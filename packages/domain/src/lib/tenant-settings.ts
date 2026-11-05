import { InvalidInputError } from './errors.js';

export interface OrganizationSettings {
  readonly name: string;
  readonly slug: string;
}
export interface ProjectSettings extends OrganizationSettings {
  readonly gitWriteMode: 'commit' | 'pull_request';
}
export interface EnvironmentSettings {
  readonly name: string;
  readonly kind: 'standard' | 'preview';
  readonly failoverPolicy: 'none' | 'restore-from-backup';
  readonly protected: boolean;
}
export interface OrganizationSettingsInput {
  readonly name: unknown;
  readonly slug: unknown;
}
export interface ProjectSettingsInput extends OrganizationSettingsInput {
  readonly gitWriteMode?: unknown;
}
export interface EnvironmentSettingsInput {
  readonly name: unknown;
  readonly kind?: unknown;
  readonly failoverPolicy?: unknown;
  readonly protected?: unknown;
}

export function organizationSettings(input: OrganizationSettingsInput): OrganizationSettings {
  return Object.freeze({ name: displayName(input.name), slug: slug(input.slug) });
}
export function projectSettings(input: ProjectSettingsInput): ProjectSettings {
  const gitWriteMode = input.gitWriteMode === undefined ? 'pull_request' : input.gitWriteMode;
  if (gitWriteMode !== 'commit' && gitWriteMode !== 'pull_request')
    throw new InvalidInputError('invalid_git_write_mode', 'Choose commit or pull_request.');
  return Object.freeze({ ...organizationSettings(input), gitWriteMode });
}
export function environmentSettings(input: EnvironmentSettingsInput): EnvironmentSettings {
  const kind = input.kind === undefined ? 'standard' : input.kind;
  const failoverPolicy = input.failoverPolicy === undefined ? 'none' : input.failoverPolicy;
  const protectedValue = input.protected === undefined ? true : input.protected;
  if (kind !== 'standard' && kind !== 'preview')
    throw new InvalidInputError('invalid_environment_kind', 'Choose standard or preview.');
  if (failoverPolicy !== 'none' && failoverPolicy !== 'restore-from-backup')
    throw new InvalidInputError('invalid_failover_policy', 'Choose none or restore-from-backup.');
  if (typeof protectedValue !== 'boolean')
    throw new InvalidInputError(
      'invalid_environment_protection',
      'Environment protection must be a boolean.',
    );
  return Object.freeze({ name: slug(input.name), kind, failoverPolicy, protected: protectedValue });
}

function displayName(value: unknown): string {
  const name = typeof value === 'string' && value.length <= 320 ? value.trim() : '';
  if (!name || Array.from(name).length > 80 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(name))
    throw new InvalidInputError(
      'invalid_resource_name',
      'Use 1–80 characters without control or format characters.',
    );
  return name;
}
function slug(value: unknown): string {
  // trim equality also excludes the terminal newline accepted by JavaScript's $ anchor.
  if (typeof value !== 'string' || value !== value.trim() || !/^[a-z][a-z0-9-]{0,39}$/.test(value))
    throw new InvalidInputError(
      'invalid_resource_slug',
      'Use 1–40 lowercase letters, digits or hyphens, starting with a letter.',
    );
  return value;
}
