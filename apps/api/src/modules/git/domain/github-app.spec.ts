import { InvalidInputError } from '@shipkeep/domain';
import { describe, expect, it } from 'vitest';

import {
  appNotConnected,
  createdGithubApp,
  GITHUB_APP_NAME_MAX,
  githubAppCreationUrl,
  githubAppManifest,
  githubAppName,
  githubManifestCode,
} from './github-app';

const organizationId = '019d0000-0000-7000-8000-00000000000a';
const state = 'a'.repeat(43);
const pem =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake+key/material==\n-----END RSA PRIVATE KEY-----\n';
const answer = {
  id: 123456,
  slug: 'shipkeep-acme-x7k2p9',
  name: 'Shipkeep acme x7k2p9',
  owner: { login: 'acme-corp' },
  client_id: 'Iv23liFake01',
  client_secret: 'fake_client_secret_value',
  webhook_secret: 'fake_webhook_secret_value',
  pem,
  html_url: 'https://github.com/apps/shipkeep-acme-x7k2p9',
};

describe('the GitHub App of an organization (ADR 0031)', () => {
  it('names the App within GitHub limit, whatever the slug', () => {
    expect(githubAppName('acme', 'x7k2p9')).toBe('Shipkeep acme x7k2p9');
    const long = githubAppName('acme-platform-engineering-team', 'x7k2p9');
    expect(long.length).toBeLessThanOrEqual(GITHUB_APP_NAME_MAX);
    expect(long).toBe('Shipkeep acme-platform-engi x7k2p9');
    // A cut never ends on a dash.
    expect(githubAppName('abcdefghijklmnopq-rest', 'x7k2p9')).toBe(
      'Shipkeep abcdefghijklmnopq x7k2p9',
    );
    expect(() => githubAppName('acme', 'TOO LONG')).toThrow();
  });

  it('asks for the permissions and the event of ADR 0031, on this installation only', () => {
    const manifest = githubAppManifest({
      name: 'Shipkeep acme x7k2p9',
      publicUrl: 'https://shipkeep.example.com/some/path',
      organizationId,
    });
    expect(manifest).toEqual({
      name: 'Shipkeep acme x7k2p9',
      url: 'https://shipkeep.example.com',
      hook_attributes: {
        url: `https://shipkeep.example.com/api/v1/webhooks/github/${organizationId}`,
        active: true,
      },
      redirect_url: `https://shipkeep.example.com/orgs/${organizationId}/integrations/github`,
      setup_url: `https://shipkeep.example.com/orgs/${organizationId}/integrations/github`,
      setup_on_update: true,
      public: false,
      default_permissions: {
        metadata: 'read',
        contents: 'write',
        pull_requests: 'write',
        statuses: 'write',
      },
      default_events: ['push'],
    });
    expect(() =>
      githubAppManifest({ name: 'x', publicUrl: 'https://a.example', organizationId: '../x' }),
    ).toThrow();
  });

  it('sends the owner to their account or to a GitHub organization, never elsewhere', () => {
    expect(githubAppCreationUrl(state)).toBe(`https://github.com/settings/apps/new?state=${state}`);
    expect(githubAppCreationUrl(state, 'acme-corp')).toBe(
      `https://github.com/organizations/acme-corp/settings/apps/new?state=${state}`,
    );
    for (const account of ['acme/../evil', '-acme', 'acme-', 'a'.repeat(40), 'ac me', ''])
      expect(() => githubAppCreationUrl(state, account)).toThrow(InvalidInputError);
    expect(() => githubAppCreationUrl('short')).toThrow();
  });

  it('refuses a code or a state that cannot be one', () => {
    expect(() => {
      githubManifestCode('abc123', state);
    }).not.toThrow();
    for (const [code, value] of [
      ['abc/../x', state],
      ['', state],
      ['x'.repeat(129), state],
      ['abc', 'short'],
      ['abc', `${'a'.repeat(42)}=`],
    ] as const)
      expect(() => {
        githubManifestCode(code, value);
      }).toThrow(InvalidInputError);
  });

  it('keeps the App GitHub answered, its secrets wrapped', () => {
    const app = createdGithubApp(answer);
    expect(app).toMatchObject({
      appId: 123456,
      slug: 'shipkeep-acme-x7k2p9',
      name: 'Shipkeep acme x7k2p9',
      ownerLogin: 'acme-corp',
      clientId: 'Iv23liFake01',
    });
    expect(app.privateKey.expose()).toBe(pem);
    expect(app.webhookSecret.expose()).toBe('fake_webhook_secret_value');
    expect(JSON.stringify(app)).not.toContain('fake_client_secret_value');
    expect(JSON.stringify(app)).not.toContain('PRIVATE KEY');
  });

  it('refuses an answer with a field it cannot use', () => {
    for (const broken of [
      null,
      'x',
      { ...answer, id: 0 },
      { ...answer, id: '123' },
      { ...answer, slug: 'Bad Slug' },
      { ...answer, name: 'x'.repeat(35) },
      { ...answer, owner: {} },
      { ...answer, owner: { login: 'a/b' } },
      { ...answer, client_id: 'id with space' },
      { ...answer, client_secret: 'short' },
      { ...answer, webhook_secret: null },
      { ...answer, pem: 'not a key' },
      { ...answer, pem: `${pem}${'A'.repeat(8192)}` },
    ])
      expect(() => createdGithubApp(broken)).toThrow(InvalidInputError);
  });

  it('names the App to delete on GitHub when it cannot be kept, and only a real slug', () => {
    expect(appNotConnected(answer).details).toEqual({
      appUrl: 'https://github.com/apps/shipkeep-acme-x7k2p9',
    });
    expect(appNotConnected({ slug: 'x/../evil' }).details).toBeUndefined();
    expect(appNotConnected(null).code).toBe('github_app_not_connected');
  });
});
