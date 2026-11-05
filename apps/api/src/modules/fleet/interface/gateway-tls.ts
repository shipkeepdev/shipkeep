import type { SecureContextOptions } from 'node:tls';

import type { Secret } from '@shipkeep/domain';

export interface GatewayCredentials {
  readonly cert: string;
  readonly key: Secret;
  readonly ca: string;
}

/**
 * TLS settings of the agent gateway, used both when the server starts and at every certificate
 * refresh. Node's `setSecureContext` resets any option it is not given, so `minVersion` must be
 * passed again each time or the gateway silently falls back to TLS 1.2 after the first refresh,
 * where client certificates travel unencrypted (SPEC 3.1 requires TLS 1.3).
 */
export function gatewaySecureContext(credentials: GatewayCredentials): SecureContextOptions {
  return {
    // The chain includes the installation CA so agents can verify it against their pinned root.
    cert: `${credentials.cert}\n${credentials.ca}`,
    key: credentials.key.expose(),
    ca: credentials.ca,
    minVersion: 'TLSv1.3',
  };
}
