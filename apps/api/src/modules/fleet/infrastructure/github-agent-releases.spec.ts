import { parseReleaseVersion, type ReleaseVersion } from '../domain/agent-upgrade';

import { digestOf, GithubAgentReleases, RELEASE_LIMITS } from './github-agent-releases';

const BASE = 'https://github.com/shipkeepdev/shipkeep/releases/download/v0.2.0/';
const ARCHIVE = 'shipkeep-agent_0.2.0_linux_amd64.tar.gz';
const DIGEST = 'a'.repeat(64);
const BUNDLE = JSON.stringify({ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' });
const CHECKSUMS = [
  `${'b'.repeat(64)}  shipkeep_0.2.0_linux_amd64.tar.gz`,
  `${DIGEST}  ${ARCHIVE}`,
  `${'c'.repeat(64)}  shipkeep-agent_0.2.0_linux_arm64.tar.gz`,
  '',
].join('\n');

function version(text: string): ReleaseVersion {
  const parsed = parseReleaseVersion(text);
  if (!parsed) throw new Error(text);
  return parsed;
}

/** GitHub as a map of URL to response; every request is recorded. */
function github(routes: Readonly<Record<string, (() => Response) | undefined>>) {
  const asked: string[] = [];
  const releases = new GithubAgentReleases((url) => {
    asked.push(url.href);
    const route = routes[url.href];
    return route ? Promise.resolve(route()) : Promise.resolve(new Response('', { status: 404 }));
  });
  return { releases, asked };
}

const ok = (body: string | Uint8Array) => () => new Response(body, { status: 200 });
const redirect = (location: string) => () =>
  new Response('', { status: 302, headers: { location } });
const files = (changes: Record<string, () => Response> = {}) => ({
  [`${BASE}checksums.txt`]: ok(CHECKSUMS),
  [`${BASE}${ARCHIVE}.sigstore.json`]: ok(BUNDLE),
  ...changes,
});

describe('GithubAgentReleases', () => {
  it('reads the archive digest from checksums.txt and its Sigstore bundle', async () => {
    const { releases, asked } = github(files());
    const release = await releases.find(version('0.2.0'), 'amd64');
    expect(release).toEqual({
      url: `${BASE}${ARCHIVE}`,
      sha256: DIGEST,
      bundleJson: new TextEncoder().encode(BUNDLE),
    });
    expect(asked).toEqual([`${BASE}checksums.txt`, `${BASE}${ARCHIVE}.sigstore.json`]);
  });

  it("follows redirects to GitHub's release storage only", async () => {
    const storage =
      'https://release-assets.githubusercontent.com/github-production-release-asset/1';
    const { releases } = github(
      files({ [`${BASE}checksums.txt`]: redirect(storage), [storage]: ok(CHECKSUMS) }),
    );
    expect((await releases.find(version('0.2.0'), 'amd64'))?.sha256).toBe(DIGEST);

    for (const location of [
      'https://evil.example.com/checksums.txt',
      'http://release-assets.githubusercontent.com/1',
      'https://user:pass@github.com/x',
      'https://github.com:8443/x',
      'https://github.com.evil.example.com/x',
      'file:///etc/passwd',
    ]) {
      const { releases: refused, asked } = github(
        files({ [`${BASE}checksums.txt`]: redirect(location) }),
      );
      expect(await refused.find(version('0.2.0'), 'amd64'), location).toBeNull();
      expect(asked).toEqual([`${BASE}checksums.txt`]);
    }
  });

  it('refuses a redirect loop and a redirect without a location', async () => {
    const loop = github(files({ [`${BASE}checksums.txt`]: redirect(`${BASE}checksums.txt`) }));
    expect(await loop.releases.find(version('0.2.0'), 'amd64')).toBeNull();
    expect(loop.asked).toHaveLength(RELEASE_LIMITS.maxRedirects + 1);
    const empty = github(
      files({ [`${BASE}checksums.txt`]: () => new Response('', { status: 301 }) }),
    );
    expect(await empty.releases.find(version('0.2.0'), 'amd64')).toBeNull();
  });

  it('refuses files larger than their bound, declared or not', async () => {
    const large = 'x'.repeat(RELEASE_LIMITS.checksumsBytes + 1);
    for (const response of [
      () => new Response(large, { status: 200 }),
      () =>
        new Response(CHECKSUMS, {
          status: 200,
          headers: { 'content-length': String(RELEASE_LIMITS.checksumsBytes + 1) },
        }),
    ]) {
      const { releases } = github(files({ [`${BASE}checksums.txt`]: response }));
      expect(await releases.find(version('0.2.0'), 'amd64')).toBeNull();
    }
    const bundle = github(
      files({
        [`${BASE}${ARCHIVE}.sigstore.json`]: ok(
          JSON.stringify({
            mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
            pad: 'x'.repeat(RELEASE_LIMITS.bundleBytes),
          }),
        ),
      }),
    );
    expect(await bundle.releases.find(version('0.2.0'), 'amd64')).toBeNull();
  });

  it('gives nothing when a file is missing, unreadable or not what it should be', async () => {
    const cases: Record<string, () => Response>[] = [
      { [`${BASE}checksums.txt`]: () => new Response('', { status: 404 }) },
      { [`${BASE}${ARCHIVE}.sigstore.json`]: () => new Response('', { status: 500 }) },
      { [`${BASE}checksums.txt`]: ok(`${DIGEST}  shipkeep-agent_0.2.0_linux_arm64.tar.gz\n`) },
      { [`${BASE}${ARCHIVE}.sigstore.json`]: ok('not json') },
      { [`${BASE}${ARCHIVE}.sigstore.json`]: ok('[]') },
      { [`${BASE}${ARCHIVE}.sigstore.json`]: ok('{"mediaType":"text/html"}') },
      { [`${BASE}${ARCHIVE}.sigstore.json`]: ok(new Uint8Array([0xff, 0xfe, 0x7b, 0x7d])) },
    ];
    for (const changes of cases) {
      const { releases } = github(files(changes));
      expect(await releases.find(version('0.2.0'), 'amd64')).toBeNull();
    }
    const failing = new GithubAgentReleases(() => Promise.reject(new TypeError('fetch failed')));
    expect(await failing.find(version('0.2.0'), 'amd64')).toBeNull();
  });

  it('takes one digest for the archive, listed once, in lowercase hex', () => {
    expect(digestOf(CHECKSUMS, ARCHIVE)).toBe(DIGEST);
    expect(digestOf(CHECKSUMS.replaceAll('\n', '\r\n'), ARCHIVE)).toBe(DIGEST);
    expect(digestOf(`${CHECKSUMS}${'d'.repeat(64)}  ${ARCHIVE}\n`, ARCHIVE)).toBeNull();
    expect(digestOf(`${'A'.repeat(64)}  ${ARCHIVE}\n`, ARCHIVE)).toBeNull();
    expect(digestOf(`${'a'.repeat(63)}  ${ARCHIVE}\n`, ARCHIVE)).toBeNull();
    expect(digestOf(`${DIGEST} ${ARCHIVE}\n`, ARCHIVE)).toBeNull();
    expect(digestOf(`${DIGEST}  ${ARCHIVE}.sbom.json\n`, ARCHIVE)).toBeNull();
    expect(digestOf('', ARCHIVE)).toBeNull();
  });
});
