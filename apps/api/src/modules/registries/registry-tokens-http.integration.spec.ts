import { createPublicKey, verify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';

import { AppConfig } from '../../platform/config/app-config';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { REGISTRY_TOKEN_KEY, type RegistryTokenKeyProvider } from '../fleet/application/ports';

import { RegistryGrants } from './application/registry-grants';

const TOKEN = '/api/v1/registry/token';
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/**
 * ADR 0030: the token endpoint of the installation's registry, with PostgreSQL. A grant issued for
 * an action buys a short token for its application's repository, signed with the key whose
 * public half is written for Distribution; anything else is refused with one same answer.
 */
describe('registry tokens over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;
  let directory = '';
  let applicationId = '';
  let service = '';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'shipkeep-registry-'));
    process.env['REGISTRY_JWKS_FILE'] = join(directory, 'jwks.json');
    fixture = await tenantHttpFixture();
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    const created = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'built-api',
          build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
          run: { port: 3000 },
        },
      })
      .expect(201);
    applicationId = (created.body as { id: string }).id;
    service = new URL(fixture.app.get(AppConfig).get('API_PUBLIC_URL')).host;
  });
  afterAll(async () => {
    Reflect.deleteProperty(process.env, 'REGISTRY_JWKS_FILE');
    await admin.end();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });

  const issue = (push: boolean, expiresAt = new Date(Date.now() + 3_600_000)) =>
    fixture.app
      .get(PrismaUnitOfWork)
      .runTenant(fixture.organizationId, () =>
        fixture.app
          .get(RegistryGrants)
          .issue(
            { organizationId: fixture.organizationId, id: applicationId },
            { push, expiresAt },
          ),
      );
  const ask = (authorization: string | undefined, scope: string[] = []) => {
    const query = new URLSearchParams({ service, account: 'ignored' });
    for (const value of scope) query.append('scope', value);
    const request = fixture.http().get(`${TOKEN}?${query.toString()}`);
    return authorization ? request.set('authorization', authorization) : request;
  };
  const claims = (token: string) => {
    const [header = '', body = ''] = token.split('.');
    return {
      header: JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<string, unknown>,
      body: JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>,
    };
  };

  it('answers a five-minute token for the repository, signed with the published key', async () => {
    const grant = await issue(true);
    const repository = `${fixture.organizationId}/${applicationId}`;
    const answer = await ask(basic(grant.username, grant.secret.expose()), [
      `repository:${repository}:pull,push`,
      `repository:${fixture.organizationId}/someone-else:pull`,
    ])
      .expect(200)
      .expect('cache-control', 'no-store');
    const body = answer.body as { token: string; access_token: string; expires_in: number };
    expect(body.access_token).toBe(body.token);
    expect(body.expires_in).toBe(300);
    const { header, body: payload } = claims(body.token);
    expect(payload).toMatchObject({
      iss: 'shipkeep',
      sub: grant.username,
      aud: service,
      access: [{ type: 'repository', name: repository, actions: ['pull', 'push'] }],
    });

    // The published JWKS names the key the token was signed with, and verifies it.
    const jwks = JSON.parse(await readFile(process.env['REGISTRY_JWKS_FILE'] ?? '', 'utf8')) as {
      keys: { kid: string; kty: string; crv: string; x: string; alg: string }[];
    };
    const key = await fixture.app.get<RegistryTokenKeyProvider>(REGISTRY_TOKEN_KEY).registryKey();
    expect(jwks.keys).toEqual([{ ...key.jwk, kid: key.keyId, use: 'sig', alg: 'EdDSA' }]);
    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: key.keyId });
    const [head = '', claimed = '', signature = ''] = body.token.split('.');
    expect(
      verify(
        null,
        Buffer.from(`${head}.${claimed}`),
        createPublicKey({ key: { ...key.jwk }, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);

    // Only the password's hash is stored, and the grant is audited without it.
    const stored = await admin.query<{ secret_sha256: string }>(
      'SELECT secret_sha256 FROM registry_grants WHERE organization_id = $1',
      [fixture.organizationId],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(grant.secret.expose());
    const events = await auditLog().findMany({ where: { action: 'registry.grant_issued' } });
    expect(events.at(-1)).toMatchObject({
      actorKind: 'system',
      targetType: 'application',
      targetId: applicationId,
      metadata: { repository, push: true },
    });
    expect(JSON.stringify(events)).not.toContain(grant.secret.expose());
  });

  it('grants a deploying server pull only, and nothing beyond the grant', async () => {
    const grant = await issue(false);
    const repository = `${fixture.organizationId}/${applicationId}`;
    const answer = await ask(basic(grant.username, grant.secret.expose()), [
      `repository:${repository}:pull,push`,
    ]).expect(200);
    expect(claims((answer.body as { token: string }).token).body['access']).toEqual([
      { type: 'repository', name: repository, actions: ['pull'] },
    ]);
    // Without a scope, as `docker login` asks: a token that grants nothing.
    const bare = await ask(basic(grant.username, grant.secret.expose())).expect(200);
    expect(claims((bare.body as { token: string }).token).body['access']).toEqual([]);
  });

  it('refuses everything else with one same answer', async () => {
    const grant = await issue(true);
    const expired = await issue(true, new Date(Date.now() + 1000));
    await admin.query(
      "UPDATE registry_grants SET expires_at = now() - interval '1 second', created_at = now() - interval '1 minute' WHERE organization_id = $1 AND id = $2",
      [fixture.organizationId, expired.username.split('.')[1]],
    );
    const other = '0190f5a8-7b1c-7e2d-8f3a-0000000000ff';
    const answers = await Promise.all(
      [
        undefined,
        `Bearer ${grant.secret.expose()}`,
        basic(grant.username, `${grant.secret.expose().slice(0, -1)}A`),
        basic(grant.username, 'short'),
        basic(`${other}.${grant.username.split('.')[1] ?? ''}`, grant.secret.expose()),
        basic(expired.username, expired.secret.expose()),
        basic(`${grant.username}' OR '1'='1`, grant.secret.expose()),
      ].map((authorization) => ask(authorization).expect(401)),
    );
    // The same problem, whatever was wrong: only the request's own identifier differs.
    const shapes = answers.map((answer) => {
      const { requestId: _id, instance: _at, ...problem } = answer.body as Record<string, unknown>;
      return JSON.stringify(problem);
    });
    expect(new Set(shapes).size).toBe(1);
    for (const answer of answers)
      expect(answer.headers['www-authenticate']).toBe('Basic realm="Shipkeep registry"');
    // A token for another registry is refused too.
    await fixture
      .http()
      .get(`${TOKEN}?service=evil.example`)
      .set('authorization', basic(grant.username, grant.secret.expose()))
      .expect(401);
  });
});
