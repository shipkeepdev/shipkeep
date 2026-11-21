import { accountName } from './account-name';

describe('accountName', () => {
  it('is the name the account set, otherwise the part of its address before the @', () => {
    expect(accountName({ email: 'ada@example.com', displayName: 'Ada Lovelace' })).toBe(
      'Ada Lovelace',
    );
    expect(accountName({ email: 'ada@example.com', displayName: null })).toBe('ada');
    expect(accountName({ email: 'ada@example.com' })).toBe('ada');
  });
});
