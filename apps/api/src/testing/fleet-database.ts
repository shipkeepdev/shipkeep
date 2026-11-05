import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { runtimeDatabase } from './runtime-database';

export interface FleetDatabase {
  /** Administrative connection for fixtures and assertions; row security does not apply. */
  readonly admin: Client;
  /** Restricted runtime login for the application under test (ADR 0015). */
  readonly runtimeUrl: string;
  /** Creates an organization with an owner, as fleet records require. */
  createOrganization(id: string): Promise<void>;
  /** Closes the administrative connection, then drops the runtime roles. */
  close(): Promise<void>;
}

/** Only for a disposable integration database that already has its migrations applied. */
export async function fleetDatabase(adminUrl: string): Promise<FleetDatabase> {
  const runtime = await runtimeDatabase(adminUrl);
  const admin = new Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch (error: unknown) {
    await runtime.close();
    throw error;
  }
  return {
    admin,
    runtimeUrl: runtime.url,
    async createOrganization(id: string): Promise<void> {
      const owner = uuidv7();
      await admin.query('BEGIN');
      try {
        await admin.query(
          "INSERT INTO users (id,email,password_hash,status,email_verified_at,updated_at) VALUES ($1,$2,'fixture-hash','active',now(),now())",
          [owner, `${owner}@example.com`],
        );
        await admin.query(
          "INSERT INTO organizations (id,name,slug,updated_at) VALUES ($1,'Fleet fixture',$2,now())",
          [id, `fleet-${id.slice(-12)}`],
        );
        await admin.query(
          "INSERT INTO memberships (id,organization_id,user_id,org_role,updated_at) VALUES ($1,$2,$3,'owner',now())",
          [uuidv7(), id, owner],
        );
        await admin.query('COMMIT');
      } catch (error: unknown) {
        await admin.query('ROLLBACK');
        throw error;
      }
    },
    async close(): Promise<void> {
      try {
        await admin.end();
      } finally {
        await runtime.close();
      }
    },
  };
}
