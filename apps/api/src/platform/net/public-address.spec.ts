import { isPublicAddress } from './public-address';

describe('isPublicAddress', () => {
  it('accepts globally routable unicast addresses', () => {
    for (const address of ['8.8.8.8', '140.82.112.33', '2606:4700::6810:84e5', '2a00:1450::1'])
      expect(isPublicAddress(address)).toBe(true);
  });

  it('refuses every internal, special or malformed address', () => {
    for (const address of [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '::',
      '::1',
      'fe80::1',
      'fd00::1',
      'fc00::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:7f00:1',
      '64:ff9b::a9fe:a9fe',
      '2001:db8::1',
      '2002:a9fe:a9fe::1',
      'localhost',
      'example.com',
      '',
      '010.0.0.1',
      '1.2.3',
    ])
      expect(isPublicAddress(address)).toBe(false);
  });
});
