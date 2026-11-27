import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../../platform/config/app-config';
import type { RegistryTokenKeyProvider } from '../../fleet/application/ports';

import { DistributionStorage } from './distribution-storage';

const REPOSITORY = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa/0190f5a8-7b1c-7e2d-8f3a-0000000000ab';
const DIGEST = `sha256:${'a'.repeat(64)}`;

const keys: RegistryTokenKeyProvider = {
  registryKey: () => Promise.resolve({ keyId: 'kid', jwk: {} } as never),
  signRegistryToken: () => Promise.resolve(new Uint8Array(64)),
};
const config = { get: () => 'http://registry:5000/' } as unknown as AppConfig;

/** The calls made, and their tokens' access claims. */
function fake(answer: (url: URL, init: RequestInit) => Response) {
  const calls: { method: string; url: URL; access: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init = {}) => {
    const url = new URL(String(input));
    const token = String((init.headers as Record<string, string>)['authorization']).slice(7);
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
      access: unknown;
      sub: string;
      aud: string;
    };
    calls.push({ method: String(init.method), url, access: claims.access });
    expect(claims.sub).toBe('shipkeep-retention');
    expect(claims.aud).toBe('cp.example.com');
    return Promise.resolve(answer(url, init));
  });
  return { storage: new DistributionStorage(config, keys, 'cp.example.com'), calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the registry as retention reads it (ADR 0030)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the catalog with a catalog token, and a repository with pull and delete on it only', async () => {
    const { storage, calls } = fake((url) =>
      url.pathname === '/v2/_catalog'
        ? json({ repositories: [REPOSITORY, 7] })
        : json({ tags: ['1', '../x', '2'] }),
    );
    expect(await storage.repositories(undefined, 100)).toEqual([REPOSITORY]);
    expect(calls[0]?.url.search).toBe('?n=100');
    expect(calls[0]?.access).toEqual([{ type: 'registry', name: 'catalog', actions: ['*'] }]);
    expect(await storage.tags(REPOSITORY)).toEqual(['1', '2']);
    expect(calls[1]?.access).toEqual([
      { type: 'repository', name: REPOSITORY, actions: ['pull', 'delete'] },
    ]);
  });

  it('reads every page of tags, up to the bound', async () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => `t${String(from + index).padStart(5, '0')}`);
    const { storage, calls } = fake((url) => {
      const last = url.searchParams.get('last');
      return json({ tags: last === null ? page(0, 1000) : page(1000, 3) });
    });
    const tags = await storage.tags(REPOSITORY);
    expect(tags).toHaveLength(1003);
    expect(calls[1]?.url.searchParams.get('last')).toBe('t00999');
  });

  it("resolves a tag's digest, deletes by digest, and takes 404 as gone", async () => {
    const { storage, calls } = fake((url, init) => {
      if (url.pathname.endsWith('/manifests/gone')) return new Response(null, { status: 404 });
      if (init.method === 'HEAD')
        return new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } });
      return new Response(null, { status: url.pathname.includes('b'.repeat(64)) ? 404 : 202 });
    });
    expect(await storage.digest(REPOSITORY, '7')).toBe(DIGEST);
    expect(await storage.digest(REPOSITORY, 'gone')).toBeUndefined();
    expect(await storage.deleteManifest(REPOSITORY, DIGEST)).toBe(true);
    expect(await storage.deleteManifest(REPOSITORY, `sha256:${'b'.repeat(64)}`)).toBe(false);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toContain(
      `DELETE /v2/${REPOSITORY}/manifests/${DIGEST}`,
    );
  });

  it('refuses a name, tag or digest it could not have read, before any call', async () => {
    const { storage, calls } = fake(() => json({}));
    for (const attempt of [
      () => storage.tags('../v2/_catalog'),
      () => storage.tags('Upper/Case'),
      () => storage.digest(REPOSITORY, 'a/../b'),
      () => storage.digest(REPOSITORY, '-flag'),
      () => storage.deleteManifest(REPOSITORY, 'sha256:short'),
      () => storage.deleteManifest(`${REPOSITORY}?x=1`, DIGEST),
    ])
      await expect(attempt()).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("throws on any other answer, without the registry's text", async () => {
    const { storage } = fake(() => new Response('internal detail', { status: 500 }));
    const error = await storage.tags(REPOSITORY).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('internal detail');
  });
});
