import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../platform/prisma/generated/client';

let adminUrl: string | undefined;
let client: PrismaClient | undefined;

/** Registers the administrative URL of the current disposable integration database. */
export function useAuditLog(url: string): void {
  adminUrl = url;
}

/** Disconnects the reader; called by the fixture that registered the URL. */
export async function releaseAuditLog(): Promise<void> {
  const current = client;
  client = undefined;
  adminUrl = undefined;
  await current?.$disconnect();
}

/**
 * Audit rows as stored, read through the administrative login. Row security hides them from the
 * runtime role outside their tenant, and hides system and account events entirely (M2.3g2).
 * Integration files run serially, so one reader per process is enough.
 */
export function auditLog(): PrismaClient['auditEvent'] {
  if (!adminUrl) throw new Error('No integration database registered for audit reads.');
  client ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: adminUrl }) });
  return client.auditEvent;
}
