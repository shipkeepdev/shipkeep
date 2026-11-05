import { ServiceUnavailableException } from '@nestjs/common';

import type { Prisma } from './generated/client';

/** Check both login and effective roles, including memberships that permit a later SET ROLE.
 * Recheck on each tenant transaction: a startup-only result goes stale after grants change.
 * Migrations use a separate administrative connection; runtime never switches to that role.
 */
export async function assertTenantDatabaseRole(client: Prisma.TransactionClient): Promise<void> {
  const rows = await client.$queryRaw<{ safe: boolean }[]>`
    WITH tenant_tables AS (
      SELECT c.oid,c.relowner,c.relrowsecurity,c.relforcerowsecurity
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r'
        AND c.relname IN ('organizations','memberships','projects','environments','role_bindings',
          'nodes','node_certificates','join_tokens','audit_events')
    )
    SELECT
      (SELECT count(*)=9 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM tenant_tables)
      AND pg_catalog.current_setting('row_security')='on'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles r
        WHERE (pg_catalog.pg_has_role(session_user,r.oid,'MEMBER')
          OR pg_catalog.pg_has_role(current_user,r.oid,'MEMBER'))
          AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolreplication
            OR r.oid IN (SELECT relowner FROM tenant_tables)
            OR pg_catalog.has_schema_privilege(r.oid,'public','CREATE')
            OR EXISTS (SELECT 1 FROM tenant_tables t
              WHERE pg_catalog.has_table_privilege(r.oid,t.oid,'TRUNCATE,TRIGGER')))
      )
      AND NOT pg_catalog.has_schema_privilege(current_user,'public','CREATE')
      AND NOT pg_catalog.has_schema_privilege(session_user,'public','CREATE')
      AND NOT EXISTS (
        SELECT 1 FROM tenant_tables t
        WHERE pg_catalog.has_table_privilege(current_user,t.oid,'TRUNCATE,TRIGGER')
          OR pg_catalog.has_table_privilege(session_user,t.oid,'TRUNCATE,TRIGGER')
      ) AS safe`;
  if (!rows[0]?.safe)
    throw new ServiceUnavailableException('Tenant storage temporarily unavailable.');
}
