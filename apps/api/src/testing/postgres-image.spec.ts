import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { POSTGRES_TEST_IMAGE } from './postgres-image';

const root = join(__dirname, '..', '..', '..', '..');

describe('POSTGRES_TEST_IMAGE', () => {
  it('is pinned to a digest', () => {
    expect(POSTGRES_TEST_IMAGE).toMatch(/^postgres:17@sha256:[0-9a-f]{64}$/);
  });

  it('matches the CI service container and the development stack', () => {
    for (const file of ['.github/workflows/ci.yml', 'deploy/dev/compose.yml']) {
      expect(readFileSync(join(root, file), 'utf8')).toContain(POSTGRES_TEST_IMAGE);
    }
  });
});
