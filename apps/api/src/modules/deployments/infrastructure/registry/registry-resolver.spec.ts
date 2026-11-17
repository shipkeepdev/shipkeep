import { createHash } from 'node:crypto';

import { Secret } from '@shipkeep/domain';

import type { RegistryRequest, RegistryResponse, RegistryTransport } from './guarded-https';
import { publicRegistryHost, RegistryAccessError } from './guarded-https';
import { bearerChallenge, RegistryResolver } from './registry-resolver';

const DIGEST = `sha256:${'b'.repeat(64)}`;
const TOKEN = 'anonymous-pull-token-fixture';

type Handler = (url: URL, init: RegistryRequest) => RegistryResponse;

function transport(handler: Handler) {
  const calls: { url: string; method: string; authorization?: string }[] = [];
  const fake: RegistryTransport = {
    request: (url, init) => {
      calls.push({
        url: url.toString(),
        method: init.method,
        ...(init.headers['Authorization'] ? { authorization: init.headers['Authorization'] } : {}),
      });
      try {
        return Promise.resolve(handler(url, init));
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error('handler failed'));
      }
    },
  };
  return { fake, calls };
}
const reply = (
  status: number,
  headers: Record<string, string> = {},
  body = '',
): RegistryResponse => ({ status, headers, body: Buffer.from(body) });
const challenge =
  'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"';

describe('RegistryResolver', () => {
  it('keeps digest-pinned references without any registry request', async () => {
    const { fake, calls } = transport(() => reply(500));
    const hosts: string[] = [];
    const resolver = new RegistryResolver(fake, (host) => {
      hosts.push(host);
      return Promise.resolve();
    });
    await expect(resolver.resolve(`ghcr.io/acme/app:1.0@${DIGEST}`)).resolves.toBe(
      `ghcr.io/acme/app@${DIGEST}`,
    );
    expect(calls).toEqual([]);
    // The registry still goes through the address policy.
    expect(hosts).toEqual(['ghcr.io']);
  });

  it('refuses a digest-pinned reference on a registry that is not public', async () => {
    const { fake, calls } = transport(() => reply(200));
    // Names resolve to whatever the test says; literals never reach the resolver.
    const check = publicRegistryHost((hostname, _options, callback) => {
      const internal: Record<string, string> = {
        'internal.example.com': '10.0.0.5',
        localhost: '127.0.0.1',
      };
      callback(null, [{ address: internal[hostname] ?? '8.8.8.8', family: 4 }]);
    });
    const resolver = new RegistryResolver(fake, check);
    for (const registry of [
      '127.0.0.1:5000',
      '10.0.0.1:5000',
      '169.254.169.254',
      'localhost:5000',
      'internal.example.com',
    ]) {
      const refusal: unknown = await resolver
        .resolve(`${registry}/team/app@${DIGEST}`)
        .catch((error: unknown) => error);
      expect(refusal, registry).toMatchObject({ code: 'image_resolution_failed' });
    }
    await expect(resolver.resolve(`registry.example.com/team/app@${DIGEST}`)).resolves.toBe(
      `registry.example.com/team/app@${DIGEST}`,
    );
    expect(calls).toEqual([]);
  });

  it('resolves a public tag through the anonymous token flow', async () => {
    const { fake, calls } = transport((url, init) => {
      if (url.hostname === 'auth.docker.io')
        return reply(200, {}, JSON.stringify({ token: TOKEN }));
      return init.headers['Authorization'] === `Bearer ${TOKEN}`
        ? reply(200, { 'docker-content-digest': DIGEST })
        : reply(401, { 'www-authenticate': challenge });
    });
    await expect(new RegistryResolver(fake).resolve('nginx:1.27')).resolves.toBe(`nginx@${DIGEST}`);
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['HEAD', 'https://registry-1.docker.io/v2/library/nginx/manifests/1.27'],
      [
        'GET',
        'https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnginx%3Apull',
      ],
      ['HEAD', 'https://registry-1.docker.io/v2/library/nginx/manifests/1.27'],
    ]);
  });

  it('hashes the manifest when the registry omits the digest header', async () => {
    const manifest = '{"schemaVersion":2}';
    const { fake } = transport((_url, init) =>
      init.method === 'HEAD' ? reply(200) : reply(200, {}, manifest),
    );
    const expected = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
    await expect(new RegistryResolver(fake).resolve('ghcr.io/acme/app')).resolves.toBe(
      `ghcr.io/acme/app@${expected}`,
    );
  });

  it('fails with a safe, explicit error', async () => {
    const cases: [string, Handler, RegExp][] = [
      ['missing tag', () => reply(404), /does not exist/],
      ['redirect', () => reply(307, { location: 'http://10.0.0.1/' }), /answered 307/],
      ['bad digest', () => reply(200, { 'docker-content-digest': 'sha256:zz' }), /invalid digest/],
      // A Basic challenge is one the stored credentials answer: without any, say what to do.
      [
        'basic auth',
        () => reply(401, { 'www-authenticate': 'Basic realm="x"' }),
        /store credentials for this registry/,
      ],
      [
        'blocked realm',
        (url) => {
          if (url.hostname === 'ghcr.io')
            return reply(401, { 'www-authenticate': 'Bearer realm="http://169.254.169.254/"' });
          throw new RegistryAccessError('registry URLs must be plain https URLs');
        },
        /plain https/,
      ],
      [
        'token without value',
        (url) =>
          url.pathname === '/token'
            ? reply(200, {}, '{"token":""}')
            : reply(401, { 'www-authenticate': 'Bearer realm="https://ghcr.io/token"' }),
        /no usable token/,
      ],
      [
        'transport failure',
        () => {
          throw new Error('getaddrinfo ENOTFOUND with secret detail');
        },
        /registry request failed/,
      ],
    ];
    for (const [name, handler, message] of cases) {
      const error = await new RegistryResolver(transport(handler).fake)
        .resolve('ghcr.io/acme/app:1')
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      expect(error, name).toMatchObject({ code: 'image_resolution_failed' });
      expect((error as Error).message, name).toMatch(message);
      expect((error as Error).message, name).not.toMatch(/secret|token-fixture/);
    }
  });

  describe('with the credentials an organization stored for the registry (ADR 0019)', () => {
    const login = {
      server: 'ghcr.io',
      username: 'deploy-bot',
      password: new Secret('sk_test_fake_registry_password'),
    };
    const basic = `Basic ${Buffer.from('deploy-bot:sk_test_fake_registry_password').toString('base64')}`;
    const ghcr = 'Bearer realm="https://ghcr.io/token",service="ghcr.io"';
    const always = () => Promise.resolve();

    it('asks the token service with them, and the registry with the token only', async () => {
      const { fake, calls } = transport((url, init) => {
        if (url.pathname === '/token')
          return init.headers['Authorization'] === basic
            ? reply(200, {}, JSON.stringify({ token: TOKEN }))
            : reply(401);
        return init.headers['Authorization'] === `Bearer ${TOKEN}`
          ? reply(200, { 'docker-content-digest': DIGEST })
          : reply(401, { 'www-authenticate': ghcr });
      });
      const resolver = new RegistryResolver(fake, always);
      await expect(resolver.resolve('ghcr.io/acme/private:1.0', login)).resolves.toBe(
        `ghcr.io/acme/private@${DIGEST}`,
      );
      expect(calls.map((call) => [new URL(call.url).pathname, call.authorization])).toEqual([
        // Nothing is sent before the registry asks.
        ['/v2/acme/private/manifests/1.0', undefined],
        ['/token', basic],
        ['/v2/acme/private/manifests/1.0', `Bearer ${TOKEN}`],
      ]);
    });

    it('answers a Basic challenge of the registry itself', async () => {
      const { fake, calls } = transport((_url, init) =>
        init.headers['Authorization'] === basic
          ? reply(200, { 'docker-content-digest': DIGEST })
          : reply(401, { 'www-authenticate': 'Basic realm="Registry Realm"' }),
      );
      const resolver = new RegistryResolver(fake, always);
      await expect(
        resolver.resolve('registry.example.com/team/app:2', {
          ...login,
          server: 'registry.example.com',
        }),
      ).resolves.toBe(`registry.example.com/team/app@${DIGEST}`);
      expect(calls.map((call) => call.authorization)).toEqual([undefined, basic]);
      // Without credentials a Basic challenge cannot be answered.
      const refusal: unknown = await resolver
        .resolve('registry.example.com/team/app:2')
        .catch((error: unknown) => error);
      expect(refusal).toMatchObject({
        code: 'image_resolution_failed',
        message: expect.stringContaining('store credentials for this registry'),
      });
    });

    it('never sends them for an image of another registry', async () => {
      const { fake, calls } = transport((url, init) => {
        if (url.pathname === '/token') return reply(200, {}, JSON.stringify({ token: TOKEN }));
        return init.headers['Authorization']
          ? reply(200, { 'docker-content-digest': DIGEST })
          : reply(401, { 'www-authenticate': 'Bearer realm="https://quay.io/token"' });
      });
      const resolver = new RegistryResolver(fake, always);
      // The caller passed the wrong organization's or registry's credentials: they are ignored.
      await expect(resolver.resolve('quay.io/acme/app:1', login)).resolves.toBe(
        `quay.io/acme/app@${DIGEST}`,
      );
      expect(calls.some((call) => call.authorization?.startsWith('Basic'))).toBe(false);
    });

    it('says when the registry refuses them, without repeating them', async () => {
      const { fake } = transport((url) =>
        url.pathname === '/token' ? reply(401) : reply(401, { 'www-authenticate': ghcr }),
      );
      const refusal: unknown = await new RegistryResolver(fake, always)
        .resolve('ghcr.io/acme/private:1.0', login)
        .catch((error: unknown) => error);
      expect(refusal).toMatchObject({
        code: 'image_resolution_failed',
        message: expect.stringContaining('the registry refused the stored credentials'),
      });
      const text = JSON.stringify(refusal) + (refusal as Error).message;
      expect(text).not.toContain('sk_test_fake_registry_password');
      expect(text).not.toContain(basic);
    });

    it('tells a private image from a missing one when nothing is stored', async () => {
      const { fake } = transport((url, init) => {
        if (url.pathname === '/token') return reply(200, {}, JSON.stringify({ token: TOKEN }));
        // An anonymous token is granted, and the manifest is still refused.
        return init.headers['Authorization']
          ? reply(401, { 'www-authenticate': ghcr })
          : reply(401, { 'www-authenticate': ghcr });
      });
      const refusal: unknown = await new RegistryResolver(fake, always)
        .resolve('ghcr.io/acme/private:1.0')
        .catch((error: unknown) => error);
      expect(refusal).toMatchObject({
        code: 'image_resolution_failed',
        message: expect.stringContaining('store credentials for this registry'),
      });
    });

    it('uses the Docker Hub credentials for an image written without a host', async () => {
      const hub = { ...login, server: 'docker.io' };
      const { fake, calls } = transport((url, init) => {
        if (url.hostname === 'auth.docker.io')
          return init.headers['Authorization'] === basic
            ? reply(200, {}, JSON.stringify({ token: TOKEN }))
            : reply(401);
        return init.headers['Authorization'] === `Bearer ${TOKEN}`
          ? reply(200, { 'docker-content-digest': DIGEST })
          : reply(401, {
              'www-authenticate':
                'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
            });
      });
      await expect(new RegistryResolver(fake, always).resolve('acme/private:1', hub)).resolves.toBe(
        `acme/private@${DIGEST}`,
      );
      expect(calls.map((call) => new URL(call.url).hostname)).toEqual([
        'registry-1.docker.io',
        'auth.docker.io',
        'registry-1.docker.io',
      ]);
    });
  });

  it('rejects hostile references before any request', async () => {
    const { fake, calls } = transport(() => reply(200));
    await expect(new RegistryResolver(fake).resolve('127.0.0.1:5000/app')).rejects.toMatchObject({
      code: 'image_resolution_failed',
    });
    await expect(new RegistryResolver(fake).resolve('ghcr.io/../app')).rejects.toMatchObject({
      code: 'invalid_image_reference',
    });
    expect(calls.every((call) => !call.url.includes('..'))).toBe(true);
  });
});

describe('bearerChallenge', () => {
  it('reads quoted parameters of a Bearer challenge only', () => {
    expect(Object.fromEntries(bearerChallenge(challenge) ?? [])).toEqual({
      realm: 'https://auth.docker.io/token',
      service: 'registry.docker.io',
      scope: 'repository:library/nginx:pull',
    });
    expect(bearerChallenge('Basic realm="x"')).toBeUndefined();
    expect(bearerChallenge(undefined)).toBeUndefined();
    expect(bearerChallenge(`Bearer realm="${'x'.repeat(3000)}"`)).toBeUndefined();
  });
});
