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
    expect(answer?.token.expose()).toBe(token.expose());
  });

  it('has no token for a repository the installation does not include, which GitHub refuses', async () => {
    const { client } = github(() => json(422, { message: 'There is at least one repository' }));
    expect(
      await client.installationToken(new Secret('jwt'), 7, {
        repositoryIds: [5],
        permissions: { contents: 'read' },
      }),
    ).toBeUndefined();
    // Asked for no repository, a refusal is GitHub being unavailable, never an empty answer.
    await expect(
      client.installationToken(new Secret('jwt'), 7, { permissions: { metadata: 'read' } }),
    ).rejects.toThrow(ServiceUnavailableException);
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
    // A revocation says whether GitHub no longer honours the token: revoked now, or no longer
    // valid; never when GitHub could not be asked.
    for (const [make, done] of [
      [() => new Response(null, { status: 204 }), true],
      [() => new Response(null, { status: 401 }), true],
      [() => new Response('internal detail', { status: 500 }), false],
      [() => Promise.reject(new TypeError('down')), false],
    ] as const)
      expect(await github(make).client.revoke(token)).toBe(done);
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

describe('the writes of a configuration change (#214)', () => {
  const commit = 'c'.repeat(40);
  /** The JSON body a call sent. */
  const sent = (call: { init: RequestInit } | undefined): unknown => {
    const body = call?.init.body;
    if (typeof body !== 'string') throw new Error('The call sent no text body.');
    return JSON.parse(body) as unknown;
  };
  const blob = 'b'.repeat(40);
  const encoded = (text: string) =>
    // GitHub cuts the base64 into lines of 60 characters.
    (
      Buffer.from(text, 'utf8')
        .toString('base64')
        .match(/.{1,60}/g) ?? []
    ).join('\n');

  it('reads a file at a branch with its blob, and only a UTF-8 file of a bounded size', async () => {
    const text = 'version: 1\nname: web # the storefront\n';
    const { client, calls } = github(() =>
      json(200, { type: 'file', encoding: 'base64', sha: blob, content: encoded(text) }),
    );
    expect(
      await client.fileAt(token, 'acme-corp/web', 'deploy/shipkeep.yml', 'release/2.x'),
    ).toEqual({ blobSha: blob, text });
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/acme-corp/web/contents/deploy/shipkeep.yml?ref=release%2F2.x',
    );
    expect(new Headers(calls[0]?.init.headers).get('accept')).toBe('application/vnd.github+json');
    expect(
      await github(() => new Response(null, { status: 404 })).client.fileAt(
        token,
        'acme-corp/web',
        'shipkeep.yml',
        commit,
      ),
    ).toBeUndefined();
    for (const answer of [
      { type: 'dir', encoding: 'base64', sha: blob, content: '' },
      { type: 'file', encoding: 'none', sha: blob, content: '' },
      { type: 'file', encoding: 'base64', sha: 'short', content: encoded(text) },
      {
        type: 'file',
        encoding: 'base64',
        sha: blob,
        content: Buffer.from([0xff, 0xfe]).toString('base64'),
      },
      { type: 'file', encoding: 'base64', sha: blob, content: encoded('x'.repeat(256 * 1024 + 1)) },
    ])
      await expect(
        github(() => json(200, answer)).client.fileAt(
          token,
          'acme-corp/web',
          'shipkeep.yml',
          'main',
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('creates a branch at a commit, and says when the name is taken or GitHub refuses it', async () => {
    const { client, calls } = github(() => json(201, { ref: 'refs/heads/shipkeep/config-1' }));
    expect(await client.createBranch(token, 'acme-corp/web', 'shipkeep/config-1', commit)).toBe(
      true,
    );
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme-corp/web/git/refs');
    expect(calls[0]?.init.method).toBe('POST');
    expect(sent(calls[0])).toEqual({
      ref: 'refs/heads/shipkeep/config-1',
      sha: commit,
    });
    // 422 means a taken name only when the branch is there.
    const taken = github((url) =>
      url.endsWith('/git/refs')
        ? json(422, { message: 'Reference already exists' })
        : json(200, { commit: { sha: commit } }),
    );
    expect(
      await taken.client.createBranch(token, 'acme-corp/web', 'shipkeep/config-1', commit),
    ).toBe(false);
    expect(taken.calls[1]?.url).toBe(
      'https://api.github.com/repos/acme-corp/web/branches/shipkeep%2Fconfig-1',
    );
    // A 422 with no branch there is GitHub refusing the branch, as a rule on names does: a
    // refused change, not GitHub unavailable.
    const refused = github((url) =>
      url.endsWith('/git/refs')
        ? json(422, { message: 'Validation Failed' })
        : new Response(null, { status: 404 }),
    );
    expect(
      await refused.client.createBranch(token, 'acme-corp/web', 'shipkeep/config-1', commit),
    ).toBe('refused');
    // A failure to ask stays GitHub unavailable.
    await expect(
      github(() => json(500, {})).client.createBranch(
        token,
        'acme-corp/web',
        'shipkeep/config-1',
        commit,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("reads a commit's message, and finds the open pull request of a branch", async () => {
    const { client, calls } = github((url) =>
      url.includes('/git/commits/')
        ? json(200, { sha: commit, message: 'Change it\n\nShipkeep-Change: abc' })
        : json(200, [{ number: 7, html_url: 'https://github.com/acme-corp/web/pull/7' }]),
    );
    expect(await client.commitMessage(token, 'acme-corp/web', commit)).toBe(
      'Change it\n\nShipkeep-Change: abc',
    );
    expect(calls[0]?.url).toBe(`https://api.github.com/repos/acme-corp/web/git/commits/${commit}`);
    expect(
      await client.openPullRequestFrom(token, 'acme-corp/web', 'shipkeep/config-1', 'main'),
    ).toEqual({ number: 7, url: 'https://github.com/acme-corp/web/pull/7' });
    expect(calls[1]?.url).toBe(
      'https://api.github.com/repos/acme-corp/web/pulls?state=open&head=acme-corp%3Ashipkeep%2Fconfig-1&base=main&per_page=1',
    );
    // None open, or no such commit.
    expect(
      await github(() => json(200, [])).client.openPullRequestFrom(
        token,
        'acme-corp/web',
        'shipkeep/config-1',
        'main',
      ),
    ).toBeUndefined();
    expect(
      await github(() => new Response(null, { status: 404 })).client.commitMessage(
        token,
        'acme-corp/web',
        commit,
      ),
    ).toBeUndefined();
    // An answer that is not what was asked is GitHub unavailable.
    await expect(
      github(() => json(200, { number: 7 })).client.openPullRequestFrom(
        token,
        'acme-corp/web',
        'shipkeep/config-1',
        'main',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('commits one file over the blob it read, and says when GitHub refuses it', async () => {
    const text = 'version: 1\nname: web\n';
    const { client, calls } = github(() =>
      json(200, {
        content: { sha: 'e'.repeat(40) },
        commit: { sha: commit, html_url: `https://github.com/acme-corp/web/commit/${commit}` },
      }),
    );
    const change = {
      branch: 'main',
      path: 'shipkeep.yml',
      text,
      blobSha: blob,
      message: 'Set replicas to 3 in shipkeep.yml\n\nProposed in Shipkeep.',
    };
    expect(await client.writeFile(token, 'acme-corp/web', change)).toEqual({
      commitSha: commit,
      url: `https://github.com/acme-corp/web/commit/${commit}`,
    });
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme-corp/web/contents/shipkeep.yml');
    expect(calls[0]?.init.method).toBe('PUT');
    expect(sent(calls[0])).toEqual({
      message: change.message,
      content: Buffer.from(text).toString('base64'),
      sha: blob,
      branch: 'main',
    });
    for (const status of [409, 422])
      expect(
        await github(() => json(status, { message: 'protected' })).client.writeFile(
          token,
          'acme-corp/web',
          change,
        ),
      ).toBe('refused');
    // A page GitHub would not link to is not a commit of this write.
    await expect(
      github(() =>
        json(200, { commit: { sha: commit, html_url: 'https://evil.example/commit' } }),
      ).client.writeFile(token, 'acme-corp/web', change),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('opens a pull request, and says when GitHub refuses it', async () => {
    const { client, calls } = github(() =>
      json(201, { number: 42, html_url: 'https://github.com/acme-corp/web/pull/42' }),
    );
    const request = {
      head: 'shipkeep/config-1',
      base: 'main',
      title: 'Set replicas to 3 in shipkeep.yml',
      body: 'Proposed in Shipkeep.\n\nMerging it deploys the change.',
    };
    expect(await client.openPullRequest(token, 'acme-corp/web', request)).toEqual({
      number: 42,
      url: 'https://github.com/acme-corp/web/pull/42',
    });
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme-corp/web/pulls');
    expect(sent(calls[0])).toEqual(request);
    expect(
      await github(() =>
        json(422, { message: 'A pull request already exists' }),
      ).client.openPullRequest(token, 'acme-corp/web', request),
    ).toBe('refused');
  });

  it('sends no request for a name, a path, a ref or a text it could not have meant', async () => {
    const { client, calls } = github(() => json(200, {}));
    const write = {
      branch: 'main',
      path: 'shipkeep.yml',
      text: 'version: 1\n',
      blobSha: blob,
      message: 'Update shipkeep.yml',
    };
    const pull = { head: 'shipkeep/config-1', base: 'main', title: 'Update', body: 'Text' };
    for (const ref of ['a..b', 'main?x=1', '', 'refs/../x', '.hidden'])
      expect(await client.fileAt(token, 'acme-corp/web', 'shipkeep.yml', ref)).toBeUndefined();
    expect(await client.fileAt(token, '../etc', 'shipkeep.yml', 'main')).toBeUndefined();
    expect(
      await client.fileAt(token, 'acme-corp/web', '../../etc/passwd.yml', 'main'),
    ).toBeUndefined();
    for (const attempt of [
      () => client.createBranch(token, 'acme-corp/web', 'a..b', commit),
      () => client.createBranch(token, 'acme-corp/web', 'shipkeep/x', 'HEAD'),
      () => client.createBranch(token, 'acme/web/extra', 'shipkeep/x', commit),
      () => client.writeFile(token, 'acme-corp/web', { ...write, path: 'a/../shipkeep.yml' }),
      () => client.writeFile(token, 'acme-corp/web', { ...write, path: 'shipkeep.json' }),
      () => client.writeFile(token, 'acme-corp/web', { ...write, branch: 'main~1' }),
      () => client.writeFile(token, 'acme-corp/web', { ...write, blobSha: 'HEAD' }),
      () => client.writeFile(token, 'acme-corp/web', { ...write, message: '' }),
      () => client.writeFile(token, 'acme-corp/web', { ...write, message: 'a\u0000b' }),
      () =>
        client.writeFile(token, 'acme-corp/web', { ...write, text: 'x'.repeat(256 * 1024 + 1) }),
      () => client.openPullRequest(token, 'acme-corp/web', { ...pull, title: 'two\nlines' }),
      () => client.openPullRequest(token, 'acme-corp/web', { ...pull, title: 'x'.repeat(257) }),
      () => client.openPullRequest(token, 'acme-corp/web', { ...pull, head: 'a b' }),
      () => client.openPullRequest(token, 'acme-corp/web', { ...pull, base: '@' }),
      () => client.openPullRequest(token, 'acme-corp/web', { ...pull, body: 'x'.repeat(4097) }),
    ])
      await expect(attempt()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(calls).toEqual([]);
  });
});
