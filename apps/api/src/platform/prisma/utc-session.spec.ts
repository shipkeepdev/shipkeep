import { assertUtcSession, NonUtcSessionError, utcSessionUrl } from './utc-session';

describe('UTC database sessions', () => {
  it('adds the time zone parameter to the connection URL', () => {
    const url = new URL(utcSessionUrl('postgresql://app:secret@db.example.com:5432/shipkeep'));
    expect(url.searchParams.get('options')).toBe('-c TimeZone=UTC');
    expect(url.username).toBe('app');
    expect(url.password).toBe('secret');
    expect(url.pathname).toBe('/shipkeep');
  });

  it('keeps the parameters the operator set, and puts UTC last so that it wins', () => {
    const url = new URL(
      utcSessionUrl(
        'postgresql://app@db.example.com/shipkeep?sslmode=require&options=-c%20statement_timeout%3D5000%20-c%20TimeZone%3DAfrica%2FKigali',
      ),
    );
    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.get('options')).toBe(
      '-c statement_timeout=5000 -c TimeZone=Africa/Kigali -c TimeZone=UTC',
    );
  });

  it('refuses a session in another zone, without the connection string in the message', () => {
    expect(() => assertUtcSession('UTC')).not.toThrow();
    for (const zone of ['Africa/Kigali', 'Etc/UTC', 'utc', '', 'UTC\n']) {
      expect(() => assertUtcSession(zone)).toThrow(NonUtcSessionError);
    }
    const error = (() => {
      try {
        assertUtcSession('x'.repeat(10_000));
      } catch (caught: unknown) {
        return caught as Error;
      }
      return undefined;
    })();
    expect(error?.message.length).toBeLessThan(300);
  });
});
