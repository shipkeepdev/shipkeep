import { createVerify, generateKeyPairSync } from 'node:crypto';

import { ServiceUnavailableException } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';
import { describe, expect, it } from 'vitest';

import { GithubApiClient, type GithubFetch } from './github-api.client';

const token = new Secret('ghs_fakeInstallationToken0123');
const NOW = new Date('2026-11-25T12:00:00Z');

function github(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const send: GithubFetch = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return { client: new GithubApiClient(send), calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const repository = (id: number) => ({
  id,
  full_name: `acme-corp/r${String(id)}`,
  default_branch: 'main',
  private: false,
});

describe('GitHub REST API as the App', () => {
  it('signs the App JWT with its private key, RS256', () => {
    // A key made for this test only, never written anywhere.
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const jwt = github(() => json(200, {}))
      .client.appJwt(42, new Secret(pem), NOW)
      .expose();
    const [header = '', claims = '', signature = ''] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iat: 1795607940,
      exp: 1795608540,
      iss: '42',
    });
    const verify = createVerify('RSA-SHA256');
    verify.update(`${header}.${claims}`);
    expect(verify.verify(publicKey, signature, 'base64url')).toBe(true);
    expect(() =>
      github(() => json(200, {})).client.appJwt(42, new Secret('not a key'), NOW),
    ).toThrow(ServiceUnavailableException);
  });

  it('asks for an installation token with the scope a call needs', async () => {
    const { client, calls } = github(() =>
      json(201, { token: token.expose(), expires_at: '2026-11-25T13:00:00Z' }),
    );
    const answer = await client.installationToken(new Secret('jwt'), 7, {
      repositoryIds: [5],
      permissions: { contents: 'read' },
    });
    expect(answer.token.expose()).toBe(token.expose());
    expect(calls[0]?.url).toBe('https://api.github.com/app/installations/7/access_tokens');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: { authorization: 'Bearer jwt', 'x-github-api-version': '2022-11-28' },
    });
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      repository_ids: [5],
      permissions: { contents: 'read' },
    });
  });

  it('lists repositories page by page, up to a limit', async () => {
    const { client, calls } = github((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      const ids = page === 1 ? Array.from({ length: 100 }, (_, i) => i + 1) : [101, 102];
      return json(200, { total_count: 102, repositories: ids.map(repository) });
    });
    const all = await client.repositories(token, 7, 500);
    expect(all.repositories).toHaveLength(102);
    expect(all.truncated).toBe(false);
    expect(calls).toHaveLength(2);
    const few = await github((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      const ids = Array.from({ length: 100 }, (_, i) => (page - 1) * 100 + i + 1);
      return json(200, { total_count: 1000, repositories: ids.map(repository) });
    }).client.repositories(token, 7, 150);
    expect(few.repositories).toHaveLength(150);
    expect(few.truncated).toBe(true);
  });

  it("reads a branch head, an unknown branch, and encodes the branch's slashes", async () => {
    const { client, calls } = github((url) =>
      url.endsWith('/missing')
        ? new Response(null, { status: 404 })
        : json(200, { commit: { sha: 'b'.repeat(40) } }),
    );
    expect(await client.branchHead(token, 'acme-corp/web', 'feature/login')).toBe('b'.repeat(40));
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/acme-corp/web/branches/feature%2Flogin',
    );
    expect(await client.branchHead(token, 'acme-corp/web', 'missing')).toBeUndefined();
    // A dot segment is never sent: GitHub would resolve it to another resource.
    const before = calls.length;
    expect(await client.branchHead(token, 'acme-corp/..', 'main')).toBeUndefined();
    expect(await client.branchHead(token, 'acme-corp/web', '.')).toBeUndefined();
    expect(calls).toHaveLength(before);
  });

  it('is unavailable on any other answer, without repeating GitHub, and revokes at best', async () => {
    for (const make of [
      () => new Response('internal detail', { status: 500 }),
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
      () => json(200, { repositories: 'not a page' }),
      () => new Response('x'.repeat((2 << 20) + 1), { status: 200 }),
      () => Promise.reject(new TypeError('network down')),
    ]) {
      const error = await github(make)
        .client.repositories(token, 7, 10)
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as Error).message).not.toMatch(/internal detail|evil|network/);
    }
    await expect(
      github(() => Promise.reject(new TypeError('down'))).client.revoke(token),
    ).resolves.toBeUndefined();
    // An entry GitHub could not have sent is left out, not the page.
    const page = await github(() =>
      json(200, { total_count: 2, repositories: [repository(0), repository(7)] }),
    ).client.repositories(token, 7, 10);
    expect(page.repositories.map((entry) => entry.id)).toEqual([7]);
  });

  it('reads a repository by its identifier, and refuses an answer about another one', async () => {
    const { client, calls } = github(() => json(200, repository(7)));
    expect(await client.repository(token, 3, 7)).toMatchObject({
      installationId: 3,
      id: 7,
      fullName: 'acme-corp/r7',
    });
    expect(calls[0]?.url).toBe('https://api.github.com/repositories/7');
    expect(
      await github(() => new Response(null, { status: 404 })).client.repository(token, 3, 7),
    ).toBeUndefined();
    await expect(
      github(() => json(200, repository(8))).client.repository(token, 3, 7),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('reads a file at a commit as raw text, bounded, and never sends a path trick', async () => {
    const commit = 'd'.repeat(40);
    const { client, calls } = github(() => new Response('version: 1\n', { status: 200 }));
    expect(await client.file(token, 'acme-corp/web', 'deploy/prod env.yml', commit)).toBe(
      'version: 1\n',
    );
    expect(calls[0]?.url).toBe(
      `https://api.github.com/repos/acme-corp/web/contents/deploy/prod%20env.yml?ref=${commit}`,
    );
    expect(new Headers(calls[0]?.init.headers).get('accept')).toBe('application/vnd.github.raw');
    expect(
      await github(() => new Response(null, { status: 404 })).client.file(
        token,
        'acme-corp/web',
        'shipkeep.yml',
        commit,
      ),
    ).toBeUndefined();
    // Larger than the largest shipkeep.yml: GitHub is unavailable, nothing is kept.
    await expect(
      github(() => new Response('x'.repeat(256 * 1024 + 1), { status: 200 })).client.file(
        token,
        'acme-corp/web',
        'shipkeep.yml',
        commit,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const before = calls.length;
    for (const [name, path, ref] of [
      ['acme-corp/..', 'shipkeep.yml', commit],
      ['acme-corp/web', '../secrets.yml', commit],
      ['acme-corp/web', 'shipkeep.yml', 'main'],
      ['acme-corp/web', 'shipkeep.yml', `${commit}&x=1`],
    ] as const)
      expect(await client.file(token, name, path, ref)).toBeUndefined();
    expect(calls).toHaveLength(before);
  });
});
