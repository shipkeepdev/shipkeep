// Runs before every unit test file (vitest `setupFiles`). The configuration module validates the
// environment when app.module.ts is imported, so test values must exist before any import.
// Values are deliberately fake and always override the developer's .env (which Nx loads into
// process.env): unit tests never touch a real database or the development KEK.
// @peculiar/x509 needs reflect-metadata before it is imported.
import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'error';
process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/shipkeep_test';
process.env['OPENAPI_UI'] = 'true';

const kekPath = join(mkdtempSync(join(tmpdir(), 'shipkeep-test-')), 'kek');
writeFileSync(kekPath, randomBytes(32), { mode: 0o400 });
process.env['SHIPKEEP_KEK_FILE'] = kekPath;
