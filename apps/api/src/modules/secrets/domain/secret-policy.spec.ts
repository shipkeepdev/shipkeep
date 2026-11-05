import { Secret } from '@shipkeep/domain';

import { assertSecretName, assertSecretValue, MAX_SECRET_BYTES } from './secret-policy';

describe('secret policy', () => {
  it('accepts environment variable names only', () => {
    for (const name of ['DATABASE_URL', '_TOKEN', 'A1'])
      expect(() => {
        assertSecretName(name);
      }).not.toThrow();
    for (const name of [
      '',
      'database_url',
      '1A',
      'A-B',
      'A B',
      'A=B',
      `A${'B'.repeat(128)}`,
      'PATH\n',
    ])
      expect(() => {
        assertSecretName(name);
      }).toThrow('Secret names');
  });

  it('bounds values without echoing them', () => {
    expect(() => {
      assertSecretValue(new Secret('postgres://user:pass@db/app'));
    }).not.toThrow();
    for (const value of ['', 'a\u0000b', 'x'.repeat(MAX_SECRET_BYTES + 1)]) {
      let message = '';
      try {
        assertSecretValue(new Secret(value));
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : '';
      }
      expect(message).toContain('Secret values');
      expect(value.length > 0 && message.includes(value.slice(0, 8)) && value !== 'a\u0000b').toBe(
        false,
      );
    }
  });
});
