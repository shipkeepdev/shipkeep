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
