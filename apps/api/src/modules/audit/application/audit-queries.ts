import { Inject, Injectable } from '@nestjs/common';

import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { ResourceSecurityContext as SecurityContext } from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import type { AuditRecord } from '../domain/audit-record';

import { AUDIT_EVENT_READER, type AuditEventReader, type AuditFilter } from './audit-event-reader';

/** Largest export in one response; the caller narrows the period to get the rest. */
export const AUDIT_EXPORT_LIMIT = 10_000;

/**
 * Scoped audit reads (PLAN M2.4a). Organization owners and admins hold `audit.read`; scoped API
 * tokens may carry it for exports. Account and system events are never returned (M2.3g2).
 */
@Injectable()
export class AuditQueries {
  constructor(
    @Inject(AUDIT_EVENT_READER) private readonly reader: AuditEventReader,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
  ) {}

  page(
    context: SecurityContext,
    organizationId: string,
    filter: AuditFilter,
    beforeId: string | undefined,
    limit: number,
  ): Promise<AuditRecord[]> {
    return this.read(context, organizationId, () =>
      this.reader.page(organizationId, filter, beforeId, Math.min(Math.max(limit, 1), 100)),
    );
  }

  /** At most AUDIT_EXPORT_LIMIT events; `truncated` reports that older matches remain. */
  async export(
    context: SecurityContext,
    organizationId: string,
    filter: AuditFilter,
  ): Promise<{ events: AuditRecord[]; truncated: boolean }> {
    const events = await this.read(context, organizationId, () =>
      this.reader.page(organizationId, filter, undefined, AUDIT_EXPORT_LIMIT + 1),
    );
    return {
      events: events.slice(0, AUDIT_EXPORT_LIMIT),
      truncated: events.length > AUDIT_EXPORT_LIMIT,
    };
  }

  private read<T>(
    context: SecurityContext,
    organizationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const target = { organizationId };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, 'audit.read', target);
        return operation();
      },
      { permission: 'audit.read', target },
    );
  }
}
