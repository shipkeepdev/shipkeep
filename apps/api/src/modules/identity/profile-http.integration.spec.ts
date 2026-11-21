import type { Server } from 'node:http';

import { Secret } from '@shipkeep/domain';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';

import { AppConfig } from '../../platform/config/app-config';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { auditLog } from '../../testing/audit-log';
import { integrationApp } from '../../testing/integration-app';

import { PASSWORD_HASHER, type PasswordHashing } from './application/identity-ports';
import { IDENTITY_STORE, type IdentityStore } from './application/identity-store';
import { SessionCommands } from './application/session-commands';
import { cookiePolicy } from './interface/session-http';

/** Issue #251: the name an account shows instead of its address. */
describe('profile HTTP acceptance', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let origin: string;
  const password = 'correct horse profile HTTP password';
  const http = () => request(fixture.app.getHttpServer() as Server);

  beforeAll(async () => {
    fixture = await integrationApp([], { restrictedDatabase: true });
    origin = new URL(fixture.app.get(AppConfig).get('API_PUBLIC_URL')).origin;
  });
  afterAll(async () => {
    await fixture.close();
  });
  beforeEach(async () => {
    await fixture.app.get(PrismaService).identityThrottle.deleteMany();
  });

  it('sets, shows and removes the name, audited, and refuses one that reads as something else', async () => {
    const id = uuidv7();
    const now = new Date();
    const email = `${id}@example.com`;
    await fixture.app.get<IdentityStore>(IDENTITY_STORE).insertUser({
      id,
      email,
      passwordHash: await fixture.app
        .get<PasswordHashing>(PASSWORD_HASHER)
        .hash(new Secret(password)),
      status: 'active',
      emailVerifiedAt: now,
      securityVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const grant = await fixture.app
      .get(SessionCommands)
      .login({ email, password: new Secret(password), ip: '127.0.0.1', userAgent: 'fixture' });
    expect(grant.displayName).toBeNull();
    const cookie = `${cookiePolicy(origin).name}=${grant.token.expose()}`;
    const set = (displayName: unknown, csrf = grant.csrf.expose()) =>
      http()
        .post('/api/v1/auth/profile')
        .set('Origin', origin)
        .set('Cookie', cookie)
        .set('X-Shipkeep-CSRF', csrf)
        .send({ displayName });
    const session = async () =>
      (await http().get('/api/v1/auth/session').set('Cookie', cookie).expect(200)).body as {
        displayName: string | null;
      };

    expect((await set('  Ada   Lovelace ').expect(200)).body).toMatchObject({
      email,
      displayName: 'Ada Lovelace',
    });
    expect((await session()).displayName).toBe('Ada Lovelace');
    // The same name again changes nothing and audits nothing.
    await set('Ada Lovelace').expect(200);
    await set('Ada‮ecalevol').expect(400);
    await set('x'.repeat(65)).expect(400);
    await set(42).expect(400);
    await set('Mallory', 'wrong-csrf').expect(401);
    expect((await session()).displayName).toBe('Ada Lovelace');
    expect((await set(null).expect(200)).body).toMatchObject({ displayName: null });
    expect((await session()).displayName).toBeNull();
    const events = await auditLog().findMany({
      where: { action: 'identity.profile_updated', actorId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => event.metadata)).toEqual([
      { displayName: 'set' },
      { displayName: 'removed' },
    ]);
    await http()
      .post('/api/v1/auth/profile')
      .set('Origin', origin)
      .send({ displayName: 'x' })
      .expect(401);
  });
});
