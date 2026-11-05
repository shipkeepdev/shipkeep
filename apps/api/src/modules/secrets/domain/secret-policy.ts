import { InvalidInputError, type Secret } from '@shipkeep/domain';

/** Environment variable name grammar for secrets (SPEC 2, `secrets:`). */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
/** Largest secret value, matching the agent's limit for secret environment variables. */
export const MAX_SECRET_BYTES = 64 * 1024;

export interface SecretTarget {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

/** What the API may say about a secret: never its value. */
export interface SecretMetadata {
  readonly name: string;
  readonly version: number;
  readonly updatedBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name))
    throw new InvalidInputError(
      'invalid_secret_name',
      'Secret names use upper-case letters, digits and underscores, starting with a letter or underscore.',
    );
}

export function assertSecretValue(value: Secret): void {
  const text = value.expose();
  if (
    text.length === 0 ||
    Buffer.byteLength(text, 'utf8') > MAX_SECRET_BYTES ||
    text.includes('\u0000')
  )
    throw new InvalidInputError(
      'invalid_secret_value',
      'Secret values must be 1 byte to 64 KiB without NUL characters.',
    );
}
