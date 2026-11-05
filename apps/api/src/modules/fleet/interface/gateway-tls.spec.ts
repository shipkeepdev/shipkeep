import { createSecureServer } from 'node:http2';

import { Secret } from '@shipkeep/domain';

import { localhostTls } from '../../../testing/localhost-tls';

import { gatewaySecureContext } from './gateway-tls';

// The effective minimum is an internal server property that Node's typings do not expose.
const minVersion = (server: object): unknown => Reflect.get(server, 'minVersion');

describe('gatewaySecureContext', () => {
  it('keeps TLS 1.3 as the minimum after a certificate refresh', async () => {
    const tls = await localhostTls();
    const credentials = { cert: tls.cert, key: new Secret(tls.key), ca: tls.cert };
    const server = createSecureServer({ ...gatewaySecureContext(credentials), allowHTTP1: false });
    expect(minVersion(server)).toBe('TLSv1.3');
    // Node resets options missing from setSecureContext; the shared settings must restore them.
    server.setSecureContext(gatewaySecureContext(credentials));
    expect(minVersion(server)).toBe('TLSv1.3');
    server.setSecureContext({ cert: tls.cert, key: tls.key });
    expect(minVersion(server)).toBeUndefined();
  });

  it('serves the certificate chain with the installation CA', () => {
    const context = gatewaySecureContext({ cert: 'LEAF', key: new Secret('KEY'), ca: 'ROOT' });
    expect(context).toMatchObject({ cert: 'LEAF\nROOT', key: 'KEY', ca: 'ROOT' });
  });
});
