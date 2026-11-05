// Prisma CLI configuration (migrations, generation). The runtime client is configured in
// src/platform/prisma/prisma.service.ts and never reads this file.
import { resolve } from 'node:path';

import { defineConfig } from 'prisma/config';

// Development convenience: read the repository .env when present (the pnpm scripts run Prisma
// from the repository root). Production sets real environment variables.
try {
  process.loadEnvFile(resolve(process.cwd(), '.env'));
} catch {
  // No .env file: environment variables must already be set.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_URL'],
  },
});
