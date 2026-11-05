import { ConfigService } from '@nestjs/config';

import { AppConfig } from '../../../platform/config/app-config';
import { parseConfig, type ParsedConfig } from '../../../platform/config/config.schema';

import { issueToken } from './identity-secrets';
import { SmtpIdentityDelivery } from './smtp-identity-delivery';

const transport = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn() }));
vi.mock('emailjs', () => ({
  SMTPClient: class {
    sendAsync = transport.send;
    smtp = { close: transport.close };
  },
}));

describe('SMTP delivery deadline and error boundary', () => {
  const config = new AppConfig(
    new ConfigService<ParsedConfig, true>(
      parseConfig({
        DATABASE_URL: 'postgresql://test:test@localhost/test',
        SHIPKEEP_KEK_FILE: '/unused/test/kek',
        SMTP_HOST: 'smtp.example.com',
        SMTP_FROM: 'mail@example.com',
      }),
    ),
  );
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a stalled connection after the hard deadline', async () => {
    transport.send.mockImplementation(
      () =>
        new Promise(() => {
          /* Simulate a stalled server. */
        }),
    );
    const promise = new SmtpIdentityDelivery(config).deliver({
      email: 'person@example.com',
      purpose: 'verify',
      token: issueToken(),
      expiresAt: new Date(Date.now() + 3600000),
    });
    const rejected = expect(promise).rejects.toThrow('Identity email delivery failed.');
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    expect(transport.close).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes transport details from errors and always closes the connection', async () => {
    transport.send.mockRejectedValue(new Error('unsafe SMTP response with credentials'));
    await expect(
      new SmtpIdentityDelivery(config).deliver({
        email: 'person@example.com',
        purpose: 'reset',
        token: issueToken(),
        expiresAt: new Date(Date.now() + 3600000),
      }),
    ).rejects.toThrow('Identity email delivery failed.');
    expect(transport.close).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
