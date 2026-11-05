import type { LookupAddress } from 'node:dns';

import { assertRegistryUrl, publicLookup, RegistryAccessError } from './guarded-https';

function lookupWith(addresses: LookupAddress[], all: boolean) {
  const lookup = publicLookup((_host, _options, callback) => {
    callback(null, addresses);
  });
  return new Promise<{ error: Error | null; result: unknown }>((resolve) => {
    lookup('registry.example.com', { all }, (error, address, family) => {
      resolve({ error, result: all ? address : [address, family] });
    });
  });
}

describe('publicLookup', () => {
  it('passes public addresses in both callback forms', async () => {
    const addresses = [
      { address: '140.82.112.33', family: 4 },
      { address: '2606:4700::6810:84e5', family: 6 },
    ];
    expect(await lookupWith(addresses, true)).toEqual({ error: null, result: addresses });
    expect(await lookupWith(addresses, false)).toEqual({
      error: null,
      result: ['140.82.112.33', 4],
    });
  });

  it('refuses a host when any address is internal, or when there is none', async () => {
    for (const addresses of [
      [{ address: '169.254.169.254', family: 4 }],
      [
        { address: '140.82.112.33', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
      [{ address: '::1', family: 6 }],
      [],
    ]) {
      const { error } = await lookupWith(addresses, true);
      expect(error).toBeInstanceOf(RegistryAccessError);
    }
  });

  it('forwards resolver errors', async () => {
    const failure = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    const lookup = publicLookup((_host, _options, callback) => {
      callback(failure, []);
    });
    const error = await new Promise((resolve) => {
      lookup('missing.example.com', { all: true }, resolve);
    });
    expect(error).toBe(failure);
  });
});

describe('assertRegistryUrl', () => {
  it('accepts plain https URLs to names and public addresses', () => {
    for (const url of [
      'https://ghcr.io/v2/acme/app/manifests/1',
      'https://registry.example.com:5000/v2/',
      'https://140.82.112.33/token',
      'https://[2606:4700::6810:84e5]/token',
    ])
      expect(() => {
        assertRegistryUrl(new URL(url));
      }).not.toThrow();
  });

  it('refuses other schemes, credentials and internal IP literals', () => {
    for (const url of [
      'http://ghcr.io/v2/',
      'file:///etc/passwd',
      'https://user:secret@ghcr.io/v2/',
      'https://127.0.0.1/v2/',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/v2/',
      'https://[::ffff:10.0.0.1]/v2/',
      'https://0x7f000001/v2/',
    ])
      expect(() => {
        assertRegistryUrl(new URL(url));
      }).toThrow(RegistryAccessError);
  });
});
