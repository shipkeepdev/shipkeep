import { ServiceUnavailableException } from '@nestjs/common';
import { InvalidInputError } from '@shipkeep/domain';
import { describe, expect, it } from 'vitest';

import { GithubManifestClient, type ManifestPost } from './github-manifest.client';

function answering(response: () => Response | Promise<Response>): {
  client: GithubManifestClient;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const post: ManifestPost = async (url, init) => {
    calls.push({ url, init });
    return response();
  };
  return { client: new GithubManifestClient(post), calls };
}

describe('GitHub manifest conversion', () => {
  it('posts the code to GitHub and reads the App it answers', async () => {
    const { client, calls } = answering(
      () => new Response(JSON.stringify({ id: 7, slug: 's' }), { status: 201 }),
    );
    expect(await client.convert('abc_123-x')).toEqual({ id: 7, slug: 's' });
    expect(calls[0]?.url).toBe('https://api.github.com/app-manifests/abc_123-x/conversions');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
  });

  it('asks the owner to start again when GitHub does not know the code', async () => {
    for (const status of [404, 422])
      await expect(
        answering(() => new Response('{"message":"Not Found"}', { status })).client.convert('x'),
      ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('fails as unavailable on any other answer, without GitHub text', async () => {
    for (const make of [
      () => new Response('internal detail', { status: 500 }),
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
      () => new Response('not json', { status: 201 }),
      () => new Response('x'.repeat(64 * 1024 + 1), { status: 201 }),
      () => Promise.reject(new TypeError('network down')),
    ]) {
      const error = await answering(make)
        .client.convert('x')
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as Error).message).not.toMatch(/internal detail|evil|network/);
    }
  });
});
