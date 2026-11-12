import { parseConfig } from './config.schema';

const minimal = {
  DATABASE_URL: 'postgresql://shipkeep:shipkeep@localhost:5432/shipkeep',
  SHIPKEEP_KEK_FILE: './deploy/dev/secrets/kek',
};

describe('parseConfig', () => {
  it('applies defaults', () => {
    const cfg = parseConfig(minimal);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.API_PORT).toBe(3000);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.AGENT_GATEWAY_ADDR).toBe('0.0.0.0:7443');
    expect(cfg.WEB_DIST_DIR).toBeUndefined();
  });

  it('wraps the database URL in a Secret', () => {
    const cfg = parseConfig(minimal);
    expect(String(cfg.DATABASE_URL)).not.toContain('shipkeep:shipkeep');
    expect(JSON.stringify(cfg)).not.toContain('shipkeep:shipkeep');
    expect(cfg.DATABASE_URL.expose()).toBe(minimal.DATABASE_URL);
  });

  it('treats empty SMTP credentials as unset, and nothing else', () => {
    const cfg = parseConfig({ ...minimal, SMTP_USER: '', SMTP_PASSWORD: '' });
    expect(cfg.SMTP_USER).toBeUndefined();
    expect(cfg.SMTP_PASSWORD).toBeUndefined();
    // Other values left empty are still refused.
    expect(() => parseConfig({ ...minimal, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
    expect(() => parseConfig({ ...minimal, SMTP_HOST: '' })).toThrow(/SMTP_HOST/);
    // One half of the SMTP credentials is still refused.
    expect(() =>
      parseConfig({
        ...minimal,
        SMTP_HOST: 'smtp.example.com',
        SMTP_FROM: 'a@example.com',
        SMTP_USER: 'u',
        SMTP_PASSWORD: '',
      }),
    ).toThrow(/SMTP_PASSWORD/);
  });

  it('coerces and bounds numbers', () => {
    expect(parseConfig({ ...minimal, API_PORT: '8080' }).API_PORT).toBe(8080);
    expect(() => parseConfig({ ...minimal, API_PORT: '70000' })).toThrow(/API_PORT/);
    expect(() => parseConfig({ ...minimal, API_PORT: 'abc' })).toThrow(/API_PORT/);
  });

  it('parses booleans from strings', () => {
    expect(parseConfig({ ...minimal, OPENAPI_UI: 'true' }).OPENAPI_UI).toBe(true);
    expect(parseConfig({ ...minimal, OPENAPI_UI: '0' }).OPENAPI_UI).toBe(false);
    expect(parseConfig(minimal).OPENAPI_UI).toBeUndefined();
  });

  it('lists every problem at once without echoing secrets', () => {
    let message = '';
    try {
      parseConfig({ DATABASE_URL: 'mysql://u:hunter2@db/x', LOG_LEVEL: 'loud' });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('LOG_LEVEL');
    expect(message).toContain('SHIPKEEP_KEK_FILE');
    expect(message).not.toContain('hunter2');
  });

  it('rejects non-http public URLs and malformed gateway addresses', () => {
    expect(() => parseConfig({ ...minimal, API_PUBLIC_URL: 'ftp://x' })).toThrow(/API_PUBLIC_URL/);
    expect(() => parseConfig({ ...minimal, AGENT_GATEWAY_ADDR: 'nope' })).toThrow(
      /AGENT_GATEWAY_ADDR/,
    );
    expect(() => parseConfig({ ...minimal, AGENT_GATEWAY_ADDR: 'localhost:99999' })).toThrow(
      /AGENT_GATEWAY_ADDR/,
    );
    expect(() =>
      parseConfig({ ...minimal, AGENT_GATEWAY_SERVER_NAME: 'https://example.com/path' }),
    ).toThrow(/AGENT_GATEWAY_SERVER_NAME/);
  });
  it('accepts an explicit built web directory and rejects invalid paths without echoing them', () => {
    expect(
      parseConfig({ ...minimal, WEB_DIST_DIR: '/opt/shipkeep/web/browser' }).WEB_DIST_DIR,
    ).toBe('/opt/shipkeep/web/browser');
    expect(() => parseConfig({ ...minimal, WEB_DIST_DIR: '' })).toThrow('WEB_DIST_DIR');
    expect(() =>
      parseConfig({ ...minimal, WEB_DIST_DIR: `private-fixture${String.fromCharCode(0)}` }),
    ).toThrow('WEB_DIST_DIR');
  });

  it('requires a safe public origin and HTTPS in production', () => {
    for (const API_PUBLIC_URL of [
      'http://user:password@example.com',
      'https://example.com/path',
      'https://example.com/?token=value',
      'https://example.com/#token',
    ]) {
      expect(() => parseConfig({ ...minimal, API_PUBLIC_URL })).toThrow(/API_PUBLIC_URL/);
    }
    expect(() => parseConfig({ ...minimal, NODE_ENV: 'production' })).toThrow(/HTTPS/);
    expect(() =>
      parseConfig({ ...minimal, NODE_ENV: 'production', API_PUBLIC_URL: 'https://example.com' }),
    ).not.toThrow();
  });

  it('validates SMTP configuration and redacts its password', () => {
    expect(() => parseConfig({ ...minimal, SMTP_HOST: 'smtp.example.com' })).toThrow(/SMTP_FROM/);
    expect(() => parseConfig({ ...minimal, SMTP_USER: 'test-user' })).toThrow(/SMTP_PASSWORD/);
    const smtp = {
      SMTP_HOST: 'smtp.example.com',
      SMTP_FROM: 'mail@example.com',
      SMTP_USER: 'test-user',
      SMTP_PASSWORD: 'smtp-test-password',
    };
    const parsed = parseConfig({ ...minimal, ...smtp });
    expect(parsed.SMTP_PORT).toBe(465);
    expect(parsed.SMTP_PASSWORD?.expose()).toBe(smtp.SMTP_PASSWORD);
    expect(JSON.stringify(parsed)).not.toContain(smtp.SMTP_PASSWORD);
    expect(() =>
      parseConfig({ ...minimal, ...smtp, SMTP_FROM: 'mail@example.com\r\nBcc: other@example.com' }),
    ).toThrow();
  });
});
