import { accountName, displayNameTooLong } from './account-name';

describe('accountName', () => {
  it('is the name the account set, otherwise the part of its address before the @', () => {
    expect(accountName({ email: 'ada@example.com', displayName: 'Ada Lovelace' })).toBe(
      'Ada Lovelace',
    );
    expect(accountName({ email: 'ada@example.com', displayName: null })).toBe('ada');
    expect(accountName({ email: 'ada@example.com' })).toBe('ada');
  });
});

describe('displayNameTooLong', () => {
  it('counts code points after the API normalization', () => {
    expect(displayNameTooLong('𝒜'.repeat(64))).toBe(false);
    expect(displayNameTooLong('a'.repeat(65))).toBe(true);
    expect(displayNameTooLong(`  ${'a'.repeat(32)}   ${'b'.repeat(31)}  `)).toBe(false);
    // NFC: "e" with a combining accent is one character once composed.
    expect(displayNameTooLong('e\u0301'.repeat(64))).toBe(false);
  });
});
