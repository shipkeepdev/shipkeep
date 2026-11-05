import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';

import type { Prisma } from './generated/client';
import { PrismaService } from './prisma.service';

/**
 * Repositories participating in a command use `client`, including the synchronous audit
 * subscriber. No transaction is shared across requests. Nested commands join their caller;
 * external I/O (mail, password hashing) must happen outside the transaction.
 */
@Injectable()
export class PrismaUnitOfWork {
  private readonly context = new AsyncLocalStorage<Prisma.TransactionClient>();

  constructor(private readonly prisma: PrismaService) {}

  get client(): Prisma.TransactionClient {
    return this.context.getStore() ?? this.prisma;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.context.getStore();
    if (current) return operation();
    return this.prisma.$transaction((transaction) => this.context.run(transaction, operation), {
      maxWait: 5000,
      timeout: 10_000,
    });
  }
}
