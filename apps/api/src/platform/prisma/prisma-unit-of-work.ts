import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConflictError, InvalidInputError, isDomainError } from '@shipkeep/domain';

import type { Prisma } from './generated/client';
import { PrismaService } from './prisma.service';
import { assertTenantDatabaseRole } from './tenant-database-role';

interface TransactionContext {
  client: Prisma.TransactionClient;
  scope?: { organizationId: string; lease: symbol };
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
  async runTenant<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(organizationId)
    )
      throw new InvalidInputError('invalid_tenant_context', 'Invalid organization context.');
    try {
      return await this.run(async () => {
        const current = this.context.getStore();
        if (!current) throw new ServiceUnavailableException();
        if (current.scope) {
          if (
            current.scope.organizationId !== organizationId ||
            current.scope.lease !== this.tenantLease.getStore()
          )
            throw new ConflictError(
              'tenant_context_conflict',
              'Organization context cannot change within a command.',
            );
          return operation();
        }
        const scope = { organizationId, lease: Symbol('tenant transaction') };
        current.scope = scope;
        try {
          await assertTenantDatabaseRole(current.client);
          await current.client
            .$queryRaw`SELECT pg_catalog.set_config('app.org_id', ${organizationId}, true)`;
          return await this.tenantLease.run(scope.lease, operation);
        } finally {
          try {
            await current.client.$queryRaw`SELECT pg_catalog.set_config('app.org_id', '', true)`;
          } finally {
            current.scope = undefined;
          }
        }
      });
    } catch (error: unknown) {
      if (isDomainError(error)) throw error;
      // PostgreSQL/Prisma diagnostics can contain tenant data and connection details.
      throw new ServiceUnavailableException('Tenant storage temporarily unavailable.');
    }
  }
}
