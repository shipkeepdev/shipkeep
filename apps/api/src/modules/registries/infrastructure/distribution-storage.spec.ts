import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../../platform/config/app-config';
import type { RegistryTokenKeyProvider } from '../../fleet/application/ports';

import { DistributionStorage } from './distribution-storage';

const REPOSITORY = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa/0190f5a8-7b1c-7e2d-8f3a-0000000000ab';

const keys: RegistryTokenKeyProvider = {
  registryKey: () => Promise.resolve({ keyId: 'kid', jwk: {} } as never),
  signRegistryToken: () => Promise.resolve(new Uint8Array(64)),
};
const config = { get: () => 'http://registry:5000/' } as unknown as AppConfig;

/** The calls made, and their tokens' access claims. */
function fake(answer: (url: URL, init: RequestInit) => Response) {
  const calls: { method: string; url: URL; access: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const token = ((init.headers as Record<string, string>)['authorization'] ?? '').slice(7);
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
        : json({ tags: url.searchParams.has('last') ? [] : ['1', '../x', '2'] }),
    );
    expect(await storage.repositories(undefined, 100)).toEqual([REPOSITORY]);
    expect(calls[0]?.url.search).toBe('?n=100');
    expect(calls[0]?.access).toEqual([{ type: 'registry', name: 'catalog', actions: ['*'] }]);
    expect(await storage.tags(REPOSITORY)).toEqual(['1', '2']);
    expect(calls[1]?.access).toEqual([
      { type: 'repository', name: REPOSITORY, actions: ['pull', 'delete'] },
    ]);
  });

  it('reads every page of tags, past a short one, to the empty one', async () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => `t${String(from + index).padStart(5, '0')}`);
    const { storage, calls } = fake((url) => {
      const last = url.searchParams.get('last');
      if (last === null) return json({ tags: page(0, 1000) });
      if (last === 't00999') return json({ tags: page(1000, 3) });
      return json({ tags: [] });
    });
    const tags = await storage.tags(REPOSITORY);
    expect(tags).toHaveLength(1003);
    expect(calls.map((call) => call.url.searchParams.get('last'))).toEqual([
      null,
      't00999',
      't01002',
    ]);
  });

  it('refuses a tag list longer than it reads, and takes one of exactly that length', async () => {
    const page = (from: number) =>
      Array.from({ length: 1000 }, (_, index) => `t${String(from + index).padStart(5, '0')}`);
    const answer = (pages: number) => (url: URL) => {
      const last = url.searchParams.get('last');
      const from = last === null ? 0 : Number(last.slice(1)) + 1;
      return json({ tags: from < pages * 1000 ? page(from) : [] });
    };
    expect(await fake(answer(10)).storage.tags(REPOSITORY)).toHaveLength(10_000);
    vi.restoreAllMocks();
    await expect(fake(answer(11)).storage.tags(REPOSITORY)).rejects.toThrow('too many tags');
  });

  it('stops on a registry that answers the same page again', async () => {
    const { storage } = fake(() => json({ tags: ['1', '2'] }));
    await expect(storage.tags(REPOSITORY)).rejects.toThrow('repeated a page');
  });

  it('deletes one tag, never a manifest, and takes 404 as gone', async () => {
    const { storage, calls } = fake(
      (url) => new Response(null, { status: url.pathname.endsWith('/manifests/gone') ? 404 : 202 }),
    );
    expect(await storage.deleteTag(REPOSITORY, '7')).toBe(true);
    expect(await storage.deleteTag(REPOSITORY, 'gone')).toBe(false);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      `DELETE /v2/${REPOSITORY}/manifests/7`,
      `DELETE /v2/${REPOSITORY}/manifests/gone`,
    ]);
    expect(calls[0]?.access).toEqual([
      { type: 'repository', name: REPOSITORY, actions: ['pull', 'delete'] },
    ]);
  });

  it('refuses a name or tag it could not have read, before any call', async () => {
    const { storage, calls } = fake(() => json({}));
    for (const attempt of [
      () => storage.tags('../v2/_catalog'),
      () => storage.tags('Upper/Case'),
      () => storage.deleteTag(REPOSITORY, 'a/../b'),
      () => storage.deleteTag(REPOSITORY, '-flag'),
      () => storage.deleteTag(REPOSITORY, `sha256:${'b'.repeat(64)}`),
      () => storage.deleteTag(`${REPOSITORY}?x=1`, '1'),
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
