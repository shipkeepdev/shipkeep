// Writes apps/api/openapi.json from the built control plane (run through `pnpm gen:openapi`).
// The API starts in document-only mode: no port is opened and no database connection is made,
// so the dummy values below never reach a real service.
// nosemgrep: ts-no-child-process -- build tooling, not control plane code; runs the API binary with fixed arguments
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'apps', 'api', 'openapi.json');

const result = spawnSync(process.execPath, [join(root, 'apps', 'api', 'dist', 'main.js')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    API_PUBLIC_URL: 'https://openapi.example.com',
    SHIPKEEP_OPENAPI_OUT: out,
    DATABASE_URL: 'postgresql://openapi:openapi@localhost:5432/openapi',
    SHIPKEEP_KEK_FILE: '/dev/null',
    LOG_LEVEL: 'warn',
  },
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(`generated ${out}`);
