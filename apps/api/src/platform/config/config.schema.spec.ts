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
  });

  it('wraps the database URL in a Secret', () => {
    const cfg = parseConfig(minimal);
    expect(String(cfg.DATABASE_URL)).not.toContain('shipkeep:shipkeep');
    expect(JSON.stringify(cfg)).not.toContain('shipkeep:shipkeep');
    expect(cfg.DATABASE_URL.expose()).toBe(minimal.DATABASE_URL);
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
  });
});
