import { assertUtcSession, NonUtcSessionError } from './utc-session';

describe('UTC database sessions', () => {
  it('refuses a session in another zone, without the connection string in the message', () => {
    expect(() => {
      assertUtcSession('UTC');
    }).not.toThrow();
    for (const zone of ['Africa/Kigali', 'Etc/UTC', 'utc', '', 'UTC\n']) {
      expect(() => {
        assertUtcSession(zone);
      }).toThrow(NonUtcSessionError);
    }
    let message = '';
    try {
      assertUtcSession('x'.repeat(10_000));
    } catch (caught: unknown) {
      message = caught instanceof Error ? caught.message : '';
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message.length).toBeLessThan(300);
  });
});
