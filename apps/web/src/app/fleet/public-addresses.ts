import type { RequestProblem } from '../identity/identity-api';

/** The API bound (SPEC: node public addresses). */
export const MAX_PUBLIC_ADDRESSES = 8;
const MAX_ADDRESS_LENGTH = 45;

/** An English message and its placeholders, translated where it is shown. */
export interface AddressMessage {
  readonly text: string;
  readonly params?: Readonly<Record<string, number>>;
}

export type AddressInput =
  | { readonly ok: true; readonly addresses: string[] }
  | { readonly ok: false; readonly message: AddressMessage };

const TOO_MANY: AddressMessage = {
  text: 'Enter at most {n} addresses.',
  params: { n: MAX_PUBLIC_ADDRESSES },
};

/**
 * Reads the editor text: addresses separated by lines, spaces or commas, blanks ignored. Only the
 * shape is checked here, to catch a typo before sending; the API decides what is a valid public
 * address and stores it canonical.
 */
export function readPublicAddresses(text: string): AddressInput {
  const addresses = text.split(/[\s,]+/).filter(Boolean);
  if (addresses.length > MAX_PUBLIC_ADDRESSES) return { ok: false, message: TOO_MANY };
  const bad = addresses.findIndex(
    (value) => value.length > MAX_ADDRESS_LENGTH || !/^[0-9a-f.:]+$/i.test(value),
  );
  if (bad >= 0)
    return {
      ok: false,
      message: { text: 'Address {n} is not an IP address.', params: { n: bad + 1 } },
    };
  return { ok: true, addresses };
}

/** What the API refused, for the field; undefined for anything a field message cannot explain. */
export function addressProblem(problem: RequestProblem | undefined): AddressMessage | undefined {
  if (problem?.code === 'node_public_addresses_too_many') return TOO_MANY;
  if (problem?.index === undefined) return undefined;
  const params = { n: problem.index + 1 };
  switch (problem.code) {
    case 'node_public_address_invalid':
      return { text: 'Address {n} is not an IPv4 or IPv6 address.', params };
    case 'node_public_address_not_public':
      return {
        text: 'Address {n} is private or reserved. Enter the address visitors reach.',
        params,
      };
    case 'node_public_address_ipv4_embedded':
      return { text: 'Address {n}: write the IPv4 address without the ::ffff: prefix.', params };
    default:
      return undefined;
  }
}
