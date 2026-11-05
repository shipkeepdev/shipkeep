import { isIPv4, isIPv6 } from 'node:net';

/**
 * Throttling key for a client address: IPv4 as is (IPv4-mapped IPv6 included), IPv6 reduced to its
 * /64 prefix, because one subscriber usually controls a whole /64 and could otherwise rotate through
 * effectively unlimited addresses. Anything else is returned unchanged.
 */
export function clientNetwork(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] && isIPv4(mapped[1])) return mapped[1];
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('%', 1)[0]?.split('::') ?? [];
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  const prefix = groups.slice(0, 4).map((group) => Number.parseInt(group || '0', 16).toString(16));
  return `${prefix.join(':')}::/64`;
}
