import { isIP, SocketAddress } from 'node:net';

import { InvalidInputError } from '@shipkeep/domain';

/**
 * Public addresses an administrator declares for a node (SPEC 5.2, PLAN M3.6b1), compared with
 * DNS answers by the domain check. A handful covers a dual-stack server with a few floating IPs.
 */
export const MAX_NODE_PUBLIC_ADDRESSES = 8;
/** Longest IPv6 text (eight groups, or six with a dotted IPv4 tail). */
const MAX_ADDRESS_LENGTH = 45;

/**
 * The canonical text of a bare IP address, or undefined for anything else: IPv4 in dotted decimal
 * without leading zeros, IPv6 compressed in lower case (RFC 5952). Zone ids, ports, prefixes,
 * brackets and surrounding whitespace are refused rather than stripped.
 */
export function canonicalIpAddress(value: string): string | undefined {
  if (value.length > MAX_ADDRESS_LENGTH || value.includes('%')) return undefined;
  const family = isIP(value);
  if (family === 0) return undefined;
  return new SocketAddress({ address: value, family: family === 4 ? 'ipv4' : 'ipv6' }).address;
}

function invalid(code: string, message: string, index: number): InvalidInputError {
  // The position only: the value may be large or carry anything.
  return new InvalidInputError(code, message, { index });
}

/**
 * Validates the addresses declared for a node and returns them canonical, deduplicated, in the
 * given order. `isPublic` decides what is globally routable (the control plane's own SSRF list),
 * so a node can never be declared at a private, loopback or link-local address.
 */
export function nodePublicAddresses(
  input: readonly unknown[],
  isPublic: (address: string) => boolean,
): string[] {
  if (input.length > MAX_NODE_PUBLIC_ADDRESSES)
    throw new InvalidInputError(
      'node_public_addresses_too_many',
      `A node has at most ${String(MAX_NODE_PUBLIC_ADDRESSES)} public addresses.`,
      { max: MAX_NODE_PUBLIC_ADDRESSES },
    );
  const addresses: string[] = [];
  input.forEach((value, index) => {
    const address = typeof value === 'string' ? canonicalIpAddress(value) : undefined;
    if (!address)
      throw invalid(
        'node_public_address_invalid',
        'Each public address must be a bare IPv4 or IPv6 address.',
        index,
      );
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms are the only ones the
    // canonical text writes with a dotted tail. One spelling per address keeps comparisons exact.
    if (address.includes('.') && address.includes(':'))
      throw invalid(
        'node_public_address_ipv4_embedded',
        'Write IPv4 addresses in their IPv4 form.',
        index,
      );
    if (!isPublic(address))
      throw invalid(
        'node_public_address_not_public',
        'Only public, globally routable addresses can be declared.',
        index,
      );
    if (!addresses.includes(address)) addresses.push(address);
  });
  return addresses;
}

/** True when two canonical lists are identical, so saving the same list records nothing. */
export function samePublicAddresses(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((address, i) => address === right[i]);
}
