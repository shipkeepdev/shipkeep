import { BlockList, isIP } from 'node:net';

/**
 * Addresses the control plane must never reach on a user's behalf (SSRF): loopback, private,
 * link-local (cloud metadata), shared, multicast, reserved and documentation ranges.
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  // IPv4-mapped and IPv4-translated addresses are checked through their IPv4 part below.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(network, prefix, 'ipv6');

const MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** True only for a syntactically valid, globally routable unicast address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = MAPPED.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  if (/^::ffff:/i.test(address)) return false;
  return !blocked.check(address, 'ipv6');
}
