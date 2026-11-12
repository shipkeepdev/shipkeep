import { Secret } from '@shipkeep/domain';

import { AuthenticationError } from '../domain/identity-policy';

import { SessionCommands } from './session-commands';

const TOKEN = new Secret('A'.repeat(43));
const NOW = new Date('2026-11-12T12:00:00Z');

function commands(overrides: { session?: object; user?: object; found?: boolean } = {}) {
  let touched = 0;
  const lookups: string[] = [];
  const store = {
    findSession: (hash: string) => {
      lookups.push(hash);
      if (overrides.found === false) return Promise.resolve(null);
      return Promise.resolve({
        session: {
          id: 's1',
          userId: 'u1',
          securityVersion: 3,
          createdAt: new Date('2026-11-12T11:00:00Z'),
          lastSeenAt: new Date('2026-11-12T11:59:00Z'),
          expiresAt: new Date('2026-11-19T11:00:00Z'),
          revokedAt: null,
          ...overrides.session,
        },
        user: { id: 'u1', status: 'active', securityVersion: 3, ...overrides.user },
      });
    },
    touchSession: () => {
      touched += 1;
      return Promise.resolve(true);
    },
  };
  const secrets = { hash: (purpose: string) => `${purpose}-hash` };
  const service = new SessionCommands(
    store as never,
    {} as never,
    secrets as never,
    {} as never,
    {} as never,
  );
  return { service, lookups, touched: () => touched };
}

describe('SessionCommands.assertLive', () => {
  it('accepts a live session of the same user without counting as activity', async () => {
    const { service, lookups, touched } = commands();
    await expect(service.assertLive('u1', TOKEN, NOW)).resolves.toBeUndefined();
    expect(lookups).toEqual(['session-hash']);
    // A stream left open must not keep an idle session alive.
    expect(touched()).toBe(0);
  });

  it.each([
    ['a session that no longer exists', { found: false }],
    ['a revoked session (sign-out)', { session: { revokedAt: new Date('2026-11-12T11:59:30Z') } }],
    ['a session past its absolute lifetime', { session: { createdAt: new Date('2020-01-01') } }],
    ['a session of another user', { session: { userId: 'u2' } }],
    ['a disabled account', { user: { status: 'disabled' } }],
    ['a password change since sign-in', { user: { securityVersion: 4 } }],
  ])('refuses %s', async (_, overrides) => {
    const { service } = commands(overrides);
    await expect(service.assertLive('u1', TOKEN, NOW)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('refuses a malformed token before any lookup', async () => {
    const { service, lookups } = commands();
    await expect(service.assertLive('u1', new Secret('short'), NOW)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(lookups).toEqual([]);
  });
});
