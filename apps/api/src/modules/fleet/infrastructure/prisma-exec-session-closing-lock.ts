import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { ExecSessionClosingLock } from '../application/ports';

/**
 * A transaction-level advisory lock per exec session (issue #489): PostgreSQL releases it on
 * commit and on rollback, so the next holder reads what the previous one committed.
 */
@Injectable()
export class PrismaExecSessionClosingLock implements ExecSessionClosingLock {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async lock(sessionId: string): Promise<void> {
    // Outside a transaction the lock would be released at once and serialize nothing.
    if (!this.database.inTransaction())
      throw new Error('an exec session closing is decided inside a transaction');
    await this.database.client
      .$queryRaw`SELECT pg_advisory_xact_lock(${execSessionClosingKey(sessionId)})::text`;
  }
}

/** The lock's key. A hash collision only makes two sessions' closings wait for each other. */
export function execSessionClosingKey(sessionId: string): bigint {
  const hash = createHash('sha256').update(`shipkeep:exec-closing:${sessionId}`).digest('hex');
  return BigInt.asIntN(64, BigInt(`0x${hash.slice(0, 16)}`));
}
