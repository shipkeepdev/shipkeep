/**
 * What an account is called on screen (issue #251): the name it set, otherwise the part of its
 * address before the @. The address itself stays shown wherever it was.
 */
export function accountName(account: {
  readonly email: string;
  readonly displayName?: string | null;
}): string {
  return account.displayName ?? account.email.split('@').at(0) ?? account.email;
}

/** The server's limit (#251): 64 code points once normalized as the API does, not UTF-16 units. */
export function displayNameTooLong(value: string): boolean {
  return Array.from(value.normalize('NFC').trim().replace(/\s+/g, ' ')).length > 64;
}
