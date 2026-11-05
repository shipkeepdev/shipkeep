import { Injectable } from '@nestjs/common';
import { parseOrganizationRole, parseResourceRole } from '@shipkeep/domain';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type {
  AdministrationStore,
  BindingView,
  MemberView,
} from '../application/administration-store';
import type { BindingTarget } from '../application/binding-store';
import type { CatalogBounds } from '../application/catalog-store';

type MemberRow = Omit<MemberView, 'orgRole'> & { orgRole: string };
type BindingRow = MemberRow & {
  role: string;
  directRole: string | null;
  inheritedRole: string | null;
};

@Injectable()
export class PrismaAdministrationStore implements AdministrationStore {
  constructor(private readonly database: PrismaUnitOfWork) {}
  transaction<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
    return this.database.runTenant(organizationId, operation);
  }
  async members(organizationId: string, bounds: CatalogBounds): Promise<MemberView[]> {
    const rows = await this.database.client.$queryRaw<MemberRow[]>`
      SELECT m.id, m.organization_id AS "organizationId", m.user_id AS "userId", m.org_role AS "orgRole",
        m.created_at AS "createdAt", m.updated_at AS "updatedAt", u.email::text AS email,
        (u.status='active' AND u.email_verified_at IS NOT NULL) AS active
      FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.organization_id=${organizationId}::uuid
        AND (${bounds.cursor ?? null}::uuid IS NULL OR m.id<${bounds.cursor ?? null}::uuid)
      ORDER BY m.id DESC LIMIT ${bounds.limit}`;
    return rows.map((row) => ({ ...row, orgRole: parseOrganizationRole(row.orgRole) }));
  }
  async bindings(target: BindingTarget, bounds: CatalogBounds): Promise<BindingView[]> {
    // One SQL snapshot selects effective grants and applies pagination, avoiding a race between
    // a membership query and a second relation query when another admin changes that grant.
    const rows = await this.database.client.$queryRaw<BindingRow[]>`
      SELECT m.id, m.organization_id AS "organizationId", m.user_id AS "userId", m.org_role AS "orgRole",
        m.created_at AS "createdAt", m.updated_at AS "updatedAt", u.email::text AS email,
        (u.status='active' AND u.email_verified_at IS NOT NULL) AS active,
        direct.role AS "directRole", inherited.role AS "inheritedRole",
        CASE WHEN m.org_role IN ('owner','admin') THEN 'admin' ELSE COALESCE(direct.role,inherited.role) END AS role
      FROM memberships m JOIN users u ON u.id=m.user_id
      LEFT JOIN role_bindings direct ON direct.organization_id=m.organization_id AND direct.membership_id=m.id
        AND direct.project_id=${target.projectId}::uuid AND direct.environment_id IS NOT DISTINCT FROM ${target.environmentId ?? null}::uuid
      LEFT JOIN role_bindings inherited ON inherited.organization_id=m.organization_id AND inherited.membership_id=m.id
        AND inherited.project_id=${target.projectId}::uuid AND inherited.environment_id IS NULL AND ${target.environmentId ?? null}::uuid IS NOT NULL
      WHERE m.organization_id=${target.organizationId}::uuid
        AND (m.org_role IN ('owner','admin') OR direct.id IS NOT NULL OR inherited.id IS NOT NULL)
        AND (${bounds.cursor ?? null}::uuid IS NULL OR m.id<${bounds.cursor ?? null}::uuid)
      ORDER BY m.id DESC LIMIT ${bounds.limit}`;
    return rows.map((row) => ({
      ...row,
      orgRole: parseOrganizationRole(row.orgRole),
      role: parseResourceRole(row.role),
      directRole: row.directRole === null ? null : parseResourceRole(row.directRole),
      inheritedRole: row.inheritedRole === null ? null : parseResourceRole(row.inheritedRole),
      source:
        row.orgRole === 'owner' || row.orgRole === 'admin'
          ? 'organization'
          : target.environmentId && row.directRole !== null
            ? 'environment'
            : 'project',
    }));
  }
}
