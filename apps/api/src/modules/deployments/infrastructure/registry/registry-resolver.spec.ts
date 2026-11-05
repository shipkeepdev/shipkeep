import { createHash } from 'node:crypto';

import type { RegistryRequest, RegistryResponse, RegistryTransport } from './guarded-https';
import { RegistryAccessError } from './guarded-https';
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
  it('keeps digest-pinned references without any network call', async () => {
    const { fake, calls } = transport(() => reply(500));
    await expect(
      new RegistryResolver(fake).resolve(`ghcr.io/acme/app:1.0@${DIGEST}`),
    ).resolves.toBe(`ghcr.io/acme/app@${DIGEST}`);
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
      ['basic auth', () => reply(401, { 'www-authenticate': 'Basic realm="x"' }), /unsupported/],
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
