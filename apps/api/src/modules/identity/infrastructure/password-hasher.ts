import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';
import { argon2id, hash, verify } from 'argon2';

import { assertPassword } from '../domain/identity-policy';

const OPTIONS = {
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;
const HASH_FORMAT = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

/** At most two 64 MiB hashes at once, with a bounded queue to protect API availability. */
@Injectable()
export class PasswordHasher {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private dummy: Promise<string> | undefined;

  async hash(password: Secret): Promise<Secret> {
    assertPassword(password.expose());
    return new Secret(await this.work(() => hash(password.expose(), OPTIONS)));
  }

  async verify(encoded: Secret | undefined, password: Secret): Promise<boolean> {
    if (password.expose().length > 1024) return false;
    const stored = encoded?.expose();
    // Never trust parameters from a corrupted database row to allocate arbitrary memory.
    const usable = stored !== undefined && HASH_FORMAT.test(stored);
    this.dummy ??= this.work(() =>
      hash('public dummy password for missing accounts', OPTIONS),
    ).catch(() => {
      this.dummy = undefined;
      throw new ServiceUnavailableException('Authentication temporarily unavailable.');
    });
    const digest = usable ? stored : await this.dummy;
    // Observe initialization even on the valid-account path.
    await this.dummy;
    const matched = await this.work(() => verify(digest, password.expose()));
    return usable && matched;
  }

  private async work<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= 2) {
      if (this.waiting.length >= 16)
        throw new ServiceUnavailableException('Authentication temporarily unavailable.');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await operation();
    } catch {
      throw new ServiceUnavailableException('Authentication temporarily unavailable.');
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
