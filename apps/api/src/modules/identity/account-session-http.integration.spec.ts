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
import { AccountSessionCommands } from './application/account-session-commands';
import { SessionCommands } from './application/session-commands';
import { cookiePolicy } from './interface/session-http';

/** Issue #253: an account lists its sessions and ends another one, which then answers 401. */
describe('account sessions HTTP acceptance', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let prisma: PrismaService;
  let passwordHash: Secret;
  let origin: string;
  const password = 'correct horse sessions HTTP password';
  const http = () => request(fixture.app.getHttpServer() as Server);
  type Browser = { cookie: string; csrf: string };
  const list = (browser: Browser) =>
    http().get('/api/v1/auth/sessions').set('Cookie', browser.cookie);
  const revoke = (browser: Browser, id: string, csrf = browser.csrf) =>
    http()
      .post(`/api/v1/auth/sessions/${id}/revoke`)
      .set('Origin', origin)
      .set('Cookie', browser.cookie)
      .set('X-Shipkeep-CSRF', csrf)
      .send({});

  beforeAll(async () => {
    fixture = await integrationApp([], { restrictedDatabase: true });
    prisma = fixture.app.get(PrismaService);
    origin = new URL(fixture.app.get(AppConfig).get('API_PUBLIC_URL')).origin;
    passwordHash = await fixture.app
      .get<PasswordHashing>(PASSWORD_HASHER)
      .hash(new Secret(password));
  });
  afterAll(async () => {
    await fixture.close();
  });
  beforeEach(async () => {
    await prisma.identityThrottle.deleteMany();
  });

  async function account(): Promise<string> {
    const id = uuidv7();
    const now = new Date();
    await fixture.app.get<IdentityStore>(IDENTITY_STORE).insertUser({
      id,
      email: `${id}@example.com`,
      passwordHash,
      status: 'active',
      emailVerifiedAt: now,
      securityVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    return `${id}@example.com`;
  }
  async function signIn(email: string, userAgent: string): Promise<Browser> {
    const session = await fixture.app
      .get(SessionCommands)
      .login({ email, password: new Secret(password), ip: '203.0.113.7', userAgent });
    return {
      cookie: `${cookiePolicy(origin).name}=${session.token.expose()}`,
      csrf: session.csrf.expose(),
    };
  }

  it('lists the sessions with the current one marked, and ends another one, audited', async () => {
    const email = await account();
    const laptop = await signIn(
      email,
      'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
    );
    const phone = await signIn(
      email,
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    );
    const listed = (await list(laptop).expect(200).expect('Cache-Control', 'no-store')).body as {
      items: {
        id: string;
        current: boolean;
        browser: string | null;
        system: string | null;
        ip: string;
      }[];
    };
    expect(listed.items).toHaveLength(2);
    const current = listed.items.find((item) => item.current);
    const other = listed.items.find((item) => !item.current);
    expect(current).toMatchObject({ browser: 'Firefox', system: 'Linux' });
    expect(other).toMatchObject({ browser: 'Safari', system: 'iOS' });
    expect(other?.ip).toBe('203.0.113.7');
    if (!current || !other) throw new Error('missing sessions');

    // This session is ended by signing out, never here.
    await revoke(laptop, current.id).expect(409);
    await revoke(laptop, other.id).expect(204);
    await http().get('/api/v1/auth/session').set('Cookie', phone.cookie).expect(401);
    await http().get('/api/v1/auth/session').set('Cookie', laptop.cookie).expect(200);
    expect(((await list(laptop).expect(200)).body as { items: unknown[] }).items).toHaveLength(1);
    // Account events have no organization: read as stored, through the administrative login.
    const audited = await auditLog().findMany({
      where: { action: 'identity.session_revoked', targetId: other.id },
    });
    expect(audited).toHaveLength(1);
    // An ended session is gone: a second revocation finds nothing.
    await revoke(laptop, other.id).expect(404);

    // A session idle past the timeout no longer signs anything in: at that time it is neither
    // listed nor ended, even before its expiry.
    await signIn(email, 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36');
    const user = await fixture.app.get<IdentityStore>(IDENTITY_STORE).findUserByEmail(email);
    if (!user) throw new Error('missing account');
    const context = {
      userId: user.id,
      securityVersion: 0,
      ip: '203.0.113.7',
      userAgent: 'fixture',
    };
    const commands = fixture.app.get(AccountSessionCommands);
    const idleSince = new Date(Date.now() + 12 * 60 * 60 * 1000 + 60_000);
    const live = await commands.list(context, current.id);
    const tablet = live.find((item) => !item.current);
    if (!tablet) throw new Error('missing session');
    expect(await commands.list(context, current.id, idleSince)).toEqual([]);
    await expect(commands.revoke(context, current.id, tablet.id, idleSince)).rejects.toThrow(
      'session not found',
    );
    await revoke(laptop, tablet.id).expect(204);
  });

  it("never lists nor ends another account's session, and needs the CSRF proof", async () => {
    const mine = await signIn(await account(), 'curl/8.5.0');
    const theirs = await signIn(await account(), 'curl/8.5.0');
    const theirSession = (
      (await list(theirs).expect(200)).body as { items: { id: string }[] }
    ).items.at(0);
    if (!theirSession) throw new Error('missing session');
    expect(
      ((await list(mine).expect(200)).body as { items: { id: string }[] }).items.map(
        (item) => item.id,
      ),
    ).not.toContain(theirSession.id);
    await revoke(mine, theirSession.id).expect(404);
    // A wrong CSRF proof is a failed session proof: 401, and nothing is ended.
    await revoke(theirs, uuidv7(), 'wrong-csrf').expect(401);
    await http().get('/api/v1/auth/session').set('Cookie', theirs.cookie).expect(200);
    await http().get('/api/v1/auth/sessions').expect(401);
  });
});
