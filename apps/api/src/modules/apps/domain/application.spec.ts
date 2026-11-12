import { InvalidInputError } from '@shipkeep/domain';

import {
  applicationConfig,
  assertSameName,
  canonicalJson,
  type ApplicationHost,
  domainDns,
  domainMatch,
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
    const check = (hostname: string, answers: readonly string[] | undefined) =>
      domainDns(hostname, answers, isPublic, [], now);
    expect(check('a.example.com', ['203.0.113.4', '10.0.0.5'])).toEqual({
      hostname: 'a.example.com',
      status: 'public',
      addresses: ['203.0.113.4'],
      match: 'not_running',
    });
    expect(check('internal.example.com', ['10.0.0.5'])).toEqual({
      hostname: 'internal.example.com',
      status: 'private',
      addresses: [],
      match: 'not_running',
    });
    expect(check('a.example.com', []).status).toBe('none');
    expect(check('a.example.com', undefined).status).toBe('unknown');
  });

  it('says whether the answers reach a node running the application', () => {
    const isPublic = (address: string) => !address.startsWith('10.');
    const host = nodeAt(['8.8.8.8']);
    expect(domainDns('a.example.com', ['8.8.8.8'], isPublic, [host], now)).toEqual({
      hostname: 'a.example.com',
      status: 'public',
      addresses: ['8.8.8.8'],
      match: 'serving',
    });
    // A private answer is never shown, but it still counts as not reaching a declared address.
    expect(domainDns('a.example.com', ['8.8.8.8', '10.0.0.5'], isPublic, [host], now)).toEqual({
      hostname: 'a.example.com',
      status: 'public',
      addresses: ['8.8.8.8'],
      match: 'partial',
    });
  });
});

const now = new Date('2026-11-11T12:00:00Z');
function nodeAt(
  publicAddresses: readonly string[],
  overrides: Partial<ApplicationHost> = {},
): ApplicationHost {
  return { status: 'ready', lastHeartbeatAt: now, publicAddresses, ...overrides };
}

describe('domainMatch', () => {
  const web1 = nodeAt(['8.8.8.8', '2606:4700:4700::1111']);
  const web2 = nodeAt(['1.1.1.1']);

  it('is serving when every answer is a declared address of a running node', () => {
    expect(domainMatch(['8.8.8.8'], [web1, web2], now)).toBe('serving');
    expect(domainMatch(['8.8.8.8', '1.1.1.1'], [web1, web2], now)).toBe('serving');
    // DNS answers are compared in canonical form.
    expect(domainMatch(['2606:4700:4700:0:0:0:0:1111'], [web1], now)).toBe('serving');
    expect(domainMatch(['2606:4700:4700::1111', '8.8.8.8'], [web1], now)).toBe('serving');
  });

  it('is partial when only some answers reach a running node', () => {
    expect(domainMatch(['8.8.8.8', '9.9.9.9'], [web1], now)).toBe('partial');
  });

  it('is elsewhere when no answer reaches a running node, or there is no record', () => {
    expect(domainMatch(['9.9.9.9'], [web1, web2], now)).toBe('elsewhere');
    expect(domainMatch(['10.0.0.5'], [web1], now)).toBe('elsewhere');
    expect(domainMatch([], [web1], now)).toBe('elsewhere');
    expect(domainMatch(['not an address', '::ffff:8.8.8.8'], [web1], now)).toBe('elsewhere');
  });

  it('cannot tell when the lookup failed or a running node has no declared address', () => {
    expect(domainMatch(undefined, [web1], now)).toBe('unknown');
    const undeclared = nodeAt([]);
    expect(domainMatch(['9.9.9.9'], [web1, undeclared], now)).toBe('unknown');
    expect(domainMatch(['8.8.8.8', '9.9.9.9'], [web1, undeclared], now)).toBe('unknown');
    expect(domainMatch(['9.9.9.9'], [undeclared], now)).toBe('unknown');
    // Still decided when every answer matches, or when there is no record at all.
    expect(domainMatch(['8.8.8.8'], [web1, undeclared], now)).toBe('serving');
    expect(domainMatch([], [undeclared], now)).toBe('elsewhere');
  });

  it('is not_running when no reachable node runs the application', () => {
    expect(domainMatch(['8.8.8.8'], [], now)).toBe('not_running');
    expect(domainMatch(undefined, [], now)).toBe('not_running');
    const silent = nodeAt(['8.8.8.8'], { lastHeartbeatAt: new Date(now.getTime() - 61_000) });
    const removed = nodeAt(['8.8.8.8'], { status: 'removed' });
    expect(domainMatch(['8.8.8.8'], [silent, removed], now)).toBe('not_running');
    // A suspect node still serves until its lease expires.
    const suspect = nodeAt(['8.8.8.8'], { lastHeartbeatAt: new Date(now.getTime() - 20_000) });
    expect(domainMatch(['8.8.8.8'], [suspect], now)).toBe('serving');
  });
});
