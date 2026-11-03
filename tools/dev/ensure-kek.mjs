// Creates the development key-encryption key when it does not exist (run by `pnpm dev`).
// The real installer generates /etc/shipkeep/kek; this one lives under deploy/dev/secrets, which
// is gitignored. Never copy a development KEK to a server.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const path = resolve(process.env['SHIPKEEP_KEK_FILE'] ?? 'deploy/dev/secrets/kek');
if (existsSync(path)) {
  console.log(`KEK present at ${path}`);
} else {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, randomBytes(32), { mode: 0o400 });
  chmodSync(path, 0o400);
  console.log(`generated development KEK at ${path}`);
}
