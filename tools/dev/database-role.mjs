// Local development only: refuses production mode and any host that is not loopback, then
// provisions the restricted login like a real installation (deploy/postgres/provision-runtime.mjs).
import { fileURLToPath } from 'node:url';

import { provisionRuntime, runtimeTargets } from '../../deploy/postgres/provision-runtime.mjs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export async function provisionDevelopmentRuntime(env) {
  let admin;
  try {
    ({ admin } = runtimeTargets(env));
  } catch {
    throw new Error('Development database-role configuration is invalid.');
  }
  if (env.NODE_ENV === 'production' || !LOOPBACK.has(admin.hostname))
    throw new Error('Development database-role configuration is invalid.');
  await provisionRuntime(env);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    try {
      process.loadEnvFile();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await provisionDevelopmentRuntime(process.env);
    console.log('Development database runtime role ready.');
  } catch {
    console.error(
      'Database-role setup failed. Configure a loopback MIGRATION_DATABASE_URL and a separate shipkeep_app DATABASE_URL; see docs/DATABASE_ROLES.md.',
    );
    process.exitCode = 1;
  }
}
