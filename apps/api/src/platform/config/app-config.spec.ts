import { Test } from '@nestjs/testing';

import { AppConfig } from './app-config';
import { AppConfigModule } from './config.module';

const KEYS = [
  'DATABASE_URL',
  'SHIPKEEP_KEK_FILE',
  'SMTP_HOST',
  'SMTP_FROM',
  'SMTP_USER',
  'SMTP_PASSWORD',
];

/**
 * Through the real module: ConfigService reads `process.env` again for what validation left out.
 * The module validates the environment once per process, so this file holds a single case.
 */
describe('AppConfig', () => {
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  async function load(env: Record<string, string>): Promise<AppConfig> {
    Object.assign(process.env, {
      DATABASE_URL: 'postgresql://shipkeep_app:fixture@localhost:5432/shipkeep',
      SHIPKEEP_KEK_FILE: './deploy/dev/secrets/kek',
      SMTP_HOST: 'smtp.example.com',
      SMTP_FROM: 'shipkeep@example.com',
      ...env,
    });
    const module = await Test.createTestingModule({ imports: [AppConfigModule] }).compile();
    return module.get(AppConfig);
  }

  it('reports empty SMTP credentials as unset, not as the raw empty variable', async () => {
    const config = await load({ SMTP_USER: '', SMTP_PASSWORD: '' });
    expect(config.get('SMTP_USER')).toBeUndefined();
    expect(config.get('SMTP_PASSWORD')).toBeUndefined();
  });
});
