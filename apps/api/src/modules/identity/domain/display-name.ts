import { InvalidInputError } from '@shipkeep/domain';

const MAX = 64;
// Control and format characters (bidirectional marks included) make a name read as something else.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * The name an account shows (issue #251): spaces trimmed and collapsed, 1 to 64 characters, no
 * control or format character. An empty name is no name (null). It is never used to sign in.
 */
export function displayName(input: string | null): string | null {
  if (input === null) return null;
  const name = input.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (name === '') return null;
  if (Array.from(name).length > MAX || HIDDEN.test(name))
    throw new InvalidInputError(
      'display_name_invalid',
      'A name has at most 64 characters, and no control character.',
    );
  return name;
}
