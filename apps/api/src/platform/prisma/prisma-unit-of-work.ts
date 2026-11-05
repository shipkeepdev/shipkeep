import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConflictError, InvalidInputError, isDomainError, isTenantId } from '@shipkeep/domain';

import type { Prisma } from './generated/client';
import { PrismaService } from './prisma.service';
import { assertTenantDatabaseRole } from './tenant-database-role';

interface TransactionContext {
  client: Prisma.TransactionClient;
  scope?: { kind: 'tenant' | 'account'; id: string; lease: symbol };
}

/**
 * Repositories participating in a command use `client`, including the synchronous audit
 * subscriber. No transaction is shared across requests. Nested commands join their caller;
 * external network I/O must happen outside the transaction. Idempotent HTTP commands include
 * bounded password work in the outer transaction so mutations and their retry result are atomic.
 */
@Injectable()
export class PrismaUnitOfWork {
  private readonly context = new AsyncLocalStorage<TransactionContext>();
  private readonly tenantLease = new AsyncLocalStorage<symbol>();

  constructor(private readonly prisma: PrismaService) {}

  get client(): Prisma.TransactionClient {
    return this.context.getStore()?.client ?? this.prisma;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.context.getStore();
    if (current) return operation();
    return this.prisma.$transaction((client) => this.context.run({ client }, operation), {
      maxWait: 5000,
      timeout: 10_000,
    });
  }

  /** A scope is not authorization: callers must still load membership and check policy.
   * Nested scopes may join only the same tenant; sibling scopes cannot race on one connection.
   * The setting is local to the transaction and cleared before returning to an outer command.
   */
  runTenant<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
    return this.runScoped('tenant', organizationId, operation);
  }

  /** Discover only this verified account's memberships and organization metadata through RLS.
   * The account id must come from authenticated identity, never a caller-selected account.
   * This mode grants no tenant writes and cannot nest inside an active tenant scope.
   */
  runAccountDiscovery<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    return this.runScoped('account', userId, operation);
  }

  private async runScoped<T>(
    kind: 'tenant' | 'account',
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!isTenantId(id))
      throw new InvalidInputError(`invalid_${kind}_context`, 'Invalid database context.');
    try {
      return await this.run(async () => {
        const current = this.context.getStore();
        if (!current) throw new ServiceUnavailableException();
        if (current.scope) {
          if (
            current.scope.kind !== kind ||
            current.scope.id !== id ||
            current.scope.lease !== this.tenantLease.getStore()
          )
            throw new ConflictError(
              'tenant_context_conflict',
              'Database context cannot change within a command.',
            );
          return operation();
        }
        const scope = { kind, id, lease: Symbol('database scope') };
        current.scope = scope;
        let result: T;
        try {
          await assertTenantDatabaseRole(current.client);
          await current.client.$queryRaw`SELECT
            pg_catalog.set_config('app.org_id', ${kind === 'tenant' ? id : ''}, true) AS organization_context,
            pg_catalog.set_config('app.user_id', ${kind === 'account' ? id : ''}, true) AS account_context`;
          result = await this.tenantLease.run(scope.lease, operation);
        } catch (error: unknown) {
          // An aborted SQL transaction also rejects cleanup. Preserve the original domain
          // error; the outer transaction still rolls back.
          await clearScope(current.client).catch(() => undefined);
          current.scope = undefined;
          throw error;
        }
        try {
          // Cleanup failure after success must fail the command, never retain a scope.
          await clearScope(current.client);
          return result;
        } finally {
          current.scope = undefined;
        }
      });
    } catch (error: unknown) {
      if (isDomainError(error)) throw error;
      // PostgreSQL/Prisma diagnostics can contain tenant data and connection details.
      throw new ServiceUnavailableException('Tenant storage temporarily unavailable.');
    }
  }
}

async function clearScope(client: Prisma.TransactionClient): Promise<void> {
  await client.$queryRaw`SELECT
    pg_catalog.set_config('app.org_id', '', true) AS organization_context,
    pg_catalog.set_config('app.user_id', '', true) AS account_context`;
}
