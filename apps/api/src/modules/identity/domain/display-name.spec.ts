import { displayName } from './display-name';

describe('displayName', () => {
  it('trims and collapses spaces, and reads an empty name as none', () => {
    expect(displayName('  Ada   Lovelace ')).toBe('Ada Lovelace');
    expect(displayName('Zoë Ndaye')).toBe('Zoë Ndaye');
    expect(displayName('   ')).toBeNull();
    // A line separator is white space: it becomes one space, the name stays on one line.
    expect(displayName('Ada\u2028Lovelace')).toBe('Ada Lovelace');
    expect(displayName(null)).toBeNull();
  });

  it.each([
    ['a name over 64 characters', 'x'.repeat(65)],
    ['a control character', 'Ada\u0007'],
    ['a bidirectional override', 'Ada‮ecalevol'],
    ['a zero-width joiner', 'Ad‍a'],
  ])('refuses %s', (_, input) => {
    expect(() => displayName(input)).toThrow('A name has at most 64 characters');
  });

  it('counts characters, not code units', () => {
    expect(displayName('é'.repeat(64))).toBe('é'.repeat(64));
  });
});
