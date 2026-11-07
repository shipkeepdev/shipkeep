import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { auditLog } from './audit-log';
import { buildCli, type CliResult, runCli } from './go-cli';
import { tenantHttpFixture } from './tenant-http';

const config = (port: number) =>
  `version: 1\nname: storefront\nbuild:\n  type: image\n  image: nginx:1.27\nrun:\n  port: ${String(port)}\n`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const SECRET_VALUE = 'cli-fixture-secret-value';

/** PLAN M8.2b: the real binary against the real API, with a real scoped token. */
describe('the shipkeep CLI against the API', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;
  let directory: string;
  let binary: string;
  let environment: Record<string, string>;
  let token: string;
  let address: string;
  let target: string[];

  const cli = (args: readonly string[], input = ''): Promise<CliResult> =>
    runCli(binary, args, environment, directory, input);
  const expectOk = (result: CliResult): CliResult => {
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
    return result;
  };

  /** No worker runs here, so a deployment is finished the way the rollback suite does it. */
  async function finishLatest(): Promise<void> {
    const { rows } = await admin.query<{ id: string; release_id: string }>(
      `SELECT id, release_id FROM deployments ORDER BY id DESC LIMIT 1`,
    );
    const latest = rows.at(0);
    if (!latest) throw new Error('No deployment exists.');
    await admin.query(`UPDATE releases SET image_digest=$1 WHERE id=$2 AND image_digest IS NULL`, [
      DIGEST,
      latest.release_id,
    ]);
    await admin.query(
      `UPDATE deployments SET state='succeeded', finished_at=now(), updated_at=now() WHERE id=$1`,
      [latest.id],
    );
  }

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    await fixture.app.listen(0, '127.0.0.1');
    address = (await fixture.app.getUrl()).replace('[::1]', '127.0.0.1');
    directory = await mkdtemp(join(tmpdir(), 'shipkeep-cli-test-'));
    binary = join(directory, 'shipkeep');
    await buildCli(binary);
    // Nothing else from this process: a saved login must be all the CLI needs.
    environment = {
      PATH: '/usr/bin:/bin',
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, 'config'),
    };
    target = [
      '--org',
      fixture.organizationId,
      '--project',
      fixture.projectId,
      '--env',
      fixture.environmentId,
    ];
    const organizationId = fixture.organizationId;
    const created = await fixture
      .post('/api/v1/api-tokens', 'owner', {
        password: fixture.password.expose(),
        name: 'CLI fixture',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        // Each permission at the one level the policy accepts it.
        scopes: [
          ...['environment.read', 'deploy.run', 'secret.write'].map((permission) => ({
            permission,
            organizationId,
            projectId: fixture.projectId,
            environmentId: fixture.environmentId,
          })),
          ...['organization.read', 'node.manage'].map((permission) => ({
            permission,
            organizationId,
          })),
        ],
      })
      .expect(201);
    token = (created.body as { token: string }).token;
  }, 180_000);
  afterAll(async () => {
    await admin.end();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('logs in with a scoped token read from standard input', async () => {
    expect((await cli(['login', '--url', address], 'not-a-real-token\n')).code).toBe(1);
    const result = expectOk(await cli(['login', '--url', address], `${token}\n`));
    expect(result.stdout).toContain('Logged in');
    expect(result.stdout + result.stderr).not.toContain(token);
  });

  it('deploys from a file: creates, updates and refuses while one is running', async () => {
    expectOk(await cli(['init', '--name', 'storefront', '--image', 'nginx:1.27']));
    const first = expectOk(await cli(['deploy', '--no-wait', ...target]));
    expect(first.stdout).toContain('Created application storefront.');
    expect(first.stdout).toContain('queued');

    const running = await cli(['deploy', '--no-wait', ...target]);
    expect(running.code).toBe(1);
    expect(running.stderr).toMatch(/\(\w+\)/);

    await finishLatest();
    const status = expectOk(await cli(['status', '--app', 'storefront', ...target]));
    expect(status.stdout).toContain('storefront');
    expect(status.stdout).toContain('succeeded');

    await writeFile(join(directory, 'shipkeep.yml'), config(8080));
    expectOk(await cli(['deploy', '--no-wait', ...target]));
    const list = await fixture.get(`${fixture.environment}/applications`).expect(200);
    const application = (list.body as { items: { config: { run: { port: number } } }[] }).items.at(
      0,
    );
    expect(application?.config.run.port).toBe(8080);
  });

  it('refuses an invalid file without touching the application', async () => {
    await writeFile(join(directory, 'bad.yml'), `${config(80)}privileged: true\n`);
    const result = await cli(['deploy', '--file', 'bad.yml', ...target]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not valid');
  });

  it('rolls back to the previous good release', async () => {
    await finishLatest();
    const result = expectOk(await cli(['rollback', '--no-wait', ...target]));
    expect(result.stdout).toContain('queued');
    const list = await fixture.get(`${fixture.environment}/applications`).expect(200);
    const id = (list.body as { items: { id: string }[] }).items.at(0)?.id ?? '';
    const deployments = await fixture
      .get(`${fixture.environment}/applications/${id}/deployments`)
      .expect(200);
    const latest = (deployments.body as { items: { trigger: string }[] }).items.at(0);
    expect(latest?.trigger).toBe('rollback');
    await finishLatest();
  });

  it('sets, lists and removes a secret without ever showing its value', async () => {
    const set = expectOk(await cli(['secrets', 'set', 'API_KEY', ...target], `${SECRET_VALUE}\n`));
    expect(set.stdout + set.stderr).not.toContain(SECRET_VALUE);
    const listed = expectOk(await cli(['secrets', 'list', ...target]));
    expect(listed.stdout.trim()).toBe('API_KEY');
    expect(listed.stdout).not.toContain(SECRET_VALUE);
    expectOk(await cli(['secrets', 'unset', 'API_KEY', ...target]));
    expect(expectOk(await cli(['secrets', 'list', ...target])).stdout.trim()).toBe('');
  });

  it('removes a server only with its exact name', async () => {
    const id = uuidv7();
    await admin.query(
      `INSERT INTO nodes (id, organization_id, name, status, labels, facts, lease_epoch, created_at)
       VALUES ($1, $2, 'edge-1', 'ready', '{}', '{}', 1, now())`,
      [id, fixture.organizationId],
    );
    const org = ['--org', fixture.organizationId];
    expect((await cli(['server', 'remove', id, ...org])).code).toBe(1);
    const wrong = await cli(['server', 'remove', id, '--confirm', 'edge-2', ...org]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('confirmation_name_mismatch');
    expectOk(await cli(['server', 'remove', id, '--confirm', 'edge-1', ...org]));
    const { rows } = await admin.query<{ status: string }>(`SELECT status FROM nodes WHERE id=$1`, [
      id,
    ]);
    expect(rows.at(0)?.status).toBe('removed');
  });

  it('records the token as the actor, and hides other organizations', async () => {
    const events = await auditLog().findMany({ where: { action: 'release.created' } });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.actorKind === 'api_token')).toBe(true);
    const foreign = await cli([
      'status',
      '--org',
      fixture.foreignId,
      '--project',
      fixture.projectId,
      '--env',
      fixture.environmentId,
    ]);
    expect(foreign.code).toBe(1);
  });

  it('forgets the login', async () => {
    expectOk(await cli(['logout']));
    const result = await cli(['status', ...target]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not logged in');
  });
});
