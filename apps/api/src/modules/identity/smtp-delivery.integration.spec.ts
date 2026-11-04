import { ConfigService } from '@nestjs/config';

import { AppConfig } from '../../platform/config/app-config';
import { parseConfig, type ParsedConfig } from '../../platform/config/config.schema';
import { smtpServer, type SmtpFixture } from '../../testing/smtp-server';

import { issueToken } from './infrastructure/identity-secrets';
import { SmtpIdentityDelivery } from './infrastructure/smtp-identity-delivery';

describe('SMTP delivery over verified TLS', () => {
  let smtp: SmtpFixture;
  let close: (() => Promise<void>) | undefined;
  const token = issueToken();
  const input = {
    email: 'person@example.com',
    purpose: 'verify' as const,
    token,
    expiresAt: new Date(Date.now() + 3600000),
  };

  beforeAll(async () => {
    smtp = await smtpServer();
    close = smtp.close;
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(() => {
    smtp.messages.length = 0;
    smtp.commands.length = 0;
  });

  function delivery(overrides: Record<string, string | undefined> = {}) {
    return new SmtpIdentityDelivery(
      new AppConfig(
        new ConfigService<ParsedConfig, true>(
          parseConfig({
            DATABASE_URL: 'postgresql://test:test@localhost/test',
            SHIPKEEP_KEK_FILE: '/unused/test/kek',
            API_PUBLIC_URL: 'https://shipkeep.example.com',
            SMTP_HOST: 'localhost',
            SMTP_PORT: String(smtp.port),
            SMTP_FROM: 'notifications@example.com',
            SMTP_USER: 'fixture-user',
            SMTP_PASSWORD: 'fixture-password',
            SMTP_CA_FILE: smtp.caFile,
            ...overrides,
          }),
        ),
      ),
    );
  }

  it('delivers the code after TLS and keeps credentials out of navigation URLs', async () => {
    await delivery().deliver(input);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]).toContain('https://shipkeep.example.com/verify-email');
    expect(smtp.messages[0]).toContain(token.expose());
    expect(smtp.messages[0]).not.toContain(`/verify-email?${token.expose()}`);
    expect(smtp.messages[0]).not.toContain(`/verify-email#${token.expose()}`);
    expect(smtp.commands.some((command) => command.startsWith('AUTH PLAIN '))).toBe(true);
    expect(smtp.commands).toContain('RCPT TO:<person@example.com>');
  });

  it('rejects an untrusted certificate before authentication or message delivery', async () => {
    await expect(delivery({ SMTP_CA_FILE: undefined }).deliver(input)).rejects.toThrow(
      'Identity email delivery failed.',
    );
    expect(smtp.messages).toHaveLength(0);
    expect(smtp.commands.some((command) => command.startsWith('AUTH'))).toBe(false);
  });

  it('rejects a trusted certificate for the wrong hostname', async () => {
    await expect(delivery({ SMTP_HOST: '127.0.0.1' }).deliver(input)).rejects.toThrow(
      'Identity email delivery failed.',
    );
    expect(smtp.messages).toHaveLength(0);
    expect(smtp.commands.some((command) => command.startsWith('AUTH'))).toBe(false);
  });

  it('rejects header injection and skips expired credentials', async () => {
    await expect(
      delivery().deliver({ ...input, email: 'person@example.com\r\nBcc: attacker@example.com' }),
    ).rejects.toThrow('Identity email delivery failed.');
    await delivery().deliver({ ...input, expiresAt: new Date(0) });
    expect(smtp.messages).toHaveLength(0);
  });
});
