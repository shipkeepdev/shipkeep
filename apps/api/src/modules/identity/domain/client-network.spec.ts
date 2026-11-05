import { clientNetwork } from './client-network';

describe('clientNetwork', () => {
  it('keeps IPv4 addresses, including IPv4-mapped IPv6', () => {
    expect(clientNetwork('192.0.2.10')).toBe('192.0.2.10');
    expect(clientNetwork('::ffff:192.0.2.10')).toBe('192.0.2.10');
    expect(clientNetwork('::FFFF:192.0.2.10')).toBe('192.0.2.10');
  });

  it('reduces IPv6 addresses to their /64 so one subscriber shares one bucket', () => {
    expect(clientNetwork('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(clientNetwork('2001:db8:1:2::ffff')).toBe('2001:db8:1:2::/64');
    expect(clientNetwork('2001:DB8:0001:0002:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(clientNetwork('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientNetwork('::1')).toBe('0:0:0:0::/64');
    expect(clientNetwork('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('leaves non-addresses untouched', () => {
    expect(clientNetwork('unknown')).toBe('unknown');
  });
});
