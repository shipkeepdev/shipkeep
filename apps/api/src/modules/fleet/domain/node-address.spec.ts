import { InvalidInputError } from '@shipkeep/domain';

import { isPublicAddress } from '../../../platform/net/public-address';

import {
  canonicalIpAddress,
  MAX_NODE_PUBLIC_ADDRESSES,
  nodePublicAddresses,
  samePublicAddresses,
} from './node-address';

const validate = (input: readonly unknown[]) => nodePublicAddresses(input, isPublicAddress);

function rejection(input: readonly unknown[]): InvalidInputError {
  try {
    validate(input);
  } catch (error: unknown) {
    if (error instanceof InvalidInputError) return error;
    throw error;
  }
  throw new Error(`accepted ${JSON.stringify(input)}`);
}

describe('canonicalIpAddress', () => {
  it('writes IPv4 as is and IPv6 in its compressed lower-case form', () => {
    expect(canonicalIpAddress('203.0.114.7')).toBe('203.0.114.7');
    expect(canonicalIpAddress('2606:4700:4700:0:0:0:0:1111')).toBe('2606:4700:4700::1111');
    expect(canonicalIpAddress('2606:4700:4700:0000:0000:0000:0000:ABCD')).toBe(
      '2606:4700:4700::abcd',
    );
  });

  it('refuses anything that is not a bare address', () => {
    for (const value of [
      '',
      'edge-1.example.com',
      'localhost',
      '01.2.3.4',
      '1.2.3',
      '0x7f.0.0.1',
      '2130706433',
      '1.2.3.4:80',
      '1.2.3.4/32',
      '[2606:4700::1]',
      'fe80::1%eth0',
      '2606:4700::1%25eth0',
      ' 1.1.1.1',
      '1.1.1.1 ',
      '1.1.1.1\n',
      ' 1.1.1.1',
      '１.1.1.1',
      `${'0:'.repeat(30)}1`,
    ])
      expect(canonicalIpAddress(value), JSON.stringify(value)).toBeUndefined();
  });
});

describe('nodePublicAddresses', () => {
  it('keeps public addresses in their canonical form, in order, without duplicates', () => {
    expect(
      validate([
        '2606:4700:4700::1111',
        '8.8.8.8',
        '2606:4700:4700:0:0:0:0:1111',
        '2606:4700:4700:0000::1111',
        '8.8.8.8',
      ]),
    ).toEqual(['2606:4700:4700::1111', '8.8.8.8']);
    expect(validate([])).toEqual([]);
  });

  it('refuses hostnames and malformed values, naming only the position', () => {
    for (const value of [
      'edge-1.example.com',
      'localhost',
      '8.8.8.8 ',
      '\t8.8.8.8',
      '8.8.8.8,1.1.1.1',
      '8.8.8.8:443',
      '2606:4700::1%eth0',
      '<script>',
      "8.8.8.8' OR '1'='1",
      '../../etc/passwd',
      'x'.repeat(10_000),
      42,
      null,
      { address: '8.8.8.8' },
    ]) {
      const error = rejection(['1.1.1.1', value]);
      expect(error.code).toBe('node_public_address_invalid');
      expect(error.details).toEqual({ index: 1 });
      if (typeof value === 'string') expect(error.message).not.toContain(value);
    }
  });

  it('refuses private, loopback, link-local, shared, multicast and unspecified addresses', () => {
    for (const value of [
      '10.0.0.5',
      '172.16.0.1',
      '192.168.1.10',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '0.0.0.0',
      '192.0.2.1',
      '::',
      '::1',
      'fe80::1',
      'fd00::1',
      'ff02::1',
      '2001:db8::1',
      '64:ff9b::808:808',
    ])
      expect(rejection([value]).code, value).toBe('node_public_address_not_public');
  });

  it('refuses IPv4 addresses written inside IPv6, even public ones', () => {
    for (const value of ['::ffff:8.8.8.8', '::FFFF:0808:0808', '::ffff:127.0.0.1', '::8.8.8.8'])
      expect(rejection([value]).code, value).toBe('node_public_address_ipv4_embedded');
  });

  it('bounds the list before looking at its values', () => {
    const many = Array.from({ length: MAX_NODE_PUBLIC_ADDRESSES + 1 }, () => '8.8.8.8');
    expect(rejection(many)).toMatchObject({
      code: 'node_public_addresses_too_many',
      details: { max: MAX_NODE_PUBLIC_ADDRESSES },
    });
    expect(validate(many.slice(1))).toEqual(['8.8.8.8']);
  });
});

describe('samePublicAddresses', () => {
  it('compares canonical lists in order', () => {
    expect(samePublicAddresses(['8.8.8.8'], ['8.8.8.8'])).toBe(true);
    expect(samePublicAddresses([], [])).toBe(true);
    expect(samePublicAddresses(['8.8.8.8', '1.1.1.1'], ['1.1.1.1', '8.8.8.8'])).toBe(false);
    expect(samePublicAddresses(['8.8.8.8'], [])).toBe(false);
  });
});
