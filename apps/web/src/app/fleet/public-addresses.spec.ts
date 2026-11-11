import { addressProblem, MAX_PUBLIC_ADDRESSES, readPublicAddresses } from './public-addresses';

describe('readPublicAddresses', () => {
  it('splits on lines, spaces and commas and ignores blanks', () => {
    expect(readPublicAddresses(' 8.8.8.8\n\n2606:4700:4700::1111 , 1.1.1.1\t')).toEqual({
      ok: true,
      addresses: ['8.8.8.8', '2606:4700:4700::1111', '1.1.1.1'],
    });
    expect(readPublicAddresses('  \n ')).toEqual({ ok: true, addresses: [] });
  });

  it('names the first value that cannot be an address', () => {
    for (const text of ['edge-1.example.com', '8.8.8.8\nlocalhost', '8.8.8.8 <b>', 'fe80::1%eth0'])
      expect(readPublicAddresses(text)).toMatchObject({
        ok: false,
        message: { text: 'Address {n} is not an IP address.' },
      });
    expect(readPublicAddresses('8.8.8.8\n1.1.1.1/32')).toEqual({
      ok: false,
      message: { text: 'Address {n} is not an IP address.', params: { n: 2 } },
    });
    expect(readPublicAddresses('1'.repeat(46))).toMatchObject({ ok: false });
  });

  it('bounds the list', () => {
    const many = Array.from({ length: MAX_PUBLIC_ADDRESSES + 1 }, () => '8.8.8.8').join('\n');
    expect(readPublicAddresses(many)).toEqual({
      ok: false,
      message: { text: 'Enter at most {n} addresses.', params: { n: 8 } },
    });
  });
});

describe('addressProblem', () => {
  it('explains each refusal of the API at its position', () => {
    expect(addressProblem({ code: 'node_public_address_not_public', index: 1 })).toEqual({
      text: 'Address {n} is private or reserved. Enter the address visitors reach.',
      params: { n: 2 },
    });
    expect(addressProblem({ code: 'node_public_address_invalid', index: 0 })?.params).toEqual({
      n: 1,
    });
    expect(addressProblem({ code: 'node_public_address_ipv4_embedded', index: 0 })?.text).toBe(
      'Address {n}: write the IPv4 address without the ::ffff: prefix.',
    );
    expect(addressProblem({ code: 'node_public_addresses_too_many' })?.text).toBe(
      'Enter at most {n} addresses.',
    );
  });

  it('leaves other refusals to the generic message', () => {
    expect(addressProblem(undefined)).toBeUndefined();
    expect(addressProblem({ code: 'node_public_address_invalid' })).toBeUndefined();
    expect(addressProblem({ code: 'resource_not_found', index: 0 })).toBeUndefined();
  });
});
