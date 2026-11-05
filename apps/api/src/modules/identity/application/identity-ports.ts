import type { Secret } from '@shipkeep/domain';

export const PASSWORD_HASHER = Symbol('PasswordHasher');
export interface PasswordHashing {
  hash(password: Secret): Promise<Secret>;
  verify(encoded: Secret | undefined, password: Secret): Promise<boolean>;
}

export const IDENTITY_SECRETS = Symbol('IdentitySecrets');
export interface IdentitySecrets {
  issue(): Secret;
  matches(
    purpose: 'session' | 'csrf' | 'verify' | 'reset' | 'api' | 'recovery',
    value: Secret,
    expectedHash: string,
  ): boolean;
  hash(
    purpose: 'session' | 'csrf' | 'verify' | 'reset' | 'api' | 'recovery',
    value: Secret,
  ): string;
}

export const IDENTITY_MAILER = Symbol('IdentityMailer');
export interface IdentityMailer {
  /** Enqueues encrypted delivery in the current command transaction; never contacts SMTP here. */
  send(input: {
    email: string;
    purpose: 'verify' | 'reset';
    token: Secret;
    expiresAt: Date;
  }): Promise<void>;
}
