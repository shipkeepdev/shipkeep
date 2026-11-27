import { Client } from 'pg';

import { tenantHttpFixture } from '../../testing/tenant-http';

import { LOGS_STORE, type LogsStore } from './application/ports';

/**
 * ADR 0032 with the real HTTP pipeline and PostgreSQL: one deployment's build output, read by
 * whoever may read its environment, for a deployment of that application only.
 */
describe("a deployment's build output", () => {
  const asked: string[] = [];
  const store: LogsStore = {
    write: () => Promise.resolve(),
    query: (logsql) => {
      asked.push(logsql);
      return Promise.resolve([
        {
          _time: '2026-11-27T10:00:00.5Z',
          _msg: '#1 [internal] load build definition from Dockerfile',
          stream: 'build',
          instance: 'build',
        },
        { _time: '2026-11-27T10:00:01Z', _msg: 'GET /health', stream: 'stdout', instance: '0' },
      ]);
    },
  };
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;
  let output = '';
  let deploymentId = '';
  let otherApplication = '';

  const application = async (name: string) => {
    const created = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name,
          build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
          run: { port: 3000 },
        },
      })
      .expect(201);
    return (created.body as { id: string }).id;
  };

  beforeAll(async () => {
    fixture = await tenantHttpFixture([{ token: LOGS_STORE, value: store }]);
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    const applicationId = await application('built-output');
    otherApplication = await application('other-output');
    const deployed = await fixture
      .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
      .expect(201);
    deploymentId = (deployed.body as { deployment: { id: string } }).deployment.id;
    output = `${fixture.environment}/applications/${applicationId}/deployments/${deploymentId}/build-output`;
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  it('answers its build lines, oldest first, read from an hour before the deployment started', async () => {
    asked.length = 0;
    const answer = await fixture.get(output, 'environmentViewer').expect(200);
    expect(answer.body).toEqual({
      kept: true,
      lines: [
        {
          time: '2026-11-27T10:00:00.500000000Z',
          line: '#1 [internal] load build definition from Dockerfile',
          truncated: false,
        },
      ],
    });
    const started = await admin.query<{ started_at: Date }>(
      'SELECT started_at FROM deployments WHERE id = $1',
      [deploymentId],
    );
    const startedAt = started.rows.at(0)?.started_at;
    if (!startedAt) throw new Error('no deployment');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`deployment:="${deploymentId}"`);
    expect(asked[0]).toContain(
      `_time:[${new Date(startedAt.getTime() - 3_600_000).toISOString()}, `,
    );
  });

  it('reads on from the exact time of the last line a live view has', async () => {
    asked.length = 0;
    await fixture
      .get(`${output}?from=${encodeURIComponent('2026-11-27T10:00:00.500000001Z')}`, 'owner')
      .expect(200);
    expect(asked[0]).toContain('_time:[2026-11-27T10:00:00.500000001Z, ');
  });

  it('refuses a time without its offset, or one to come', async () => {
    for (const from of ['2026-11-27T10:00:00', '2999-01-01T00:00:00Z'])
      await fixture.get(`${output}?from=${encodeURIComponent(from)}`, 'owner').expect(400);
  });

  it('is not found for an outsider, or under another application', async () => {
    asked.length = 0;
    await fixture.get(output, 'outsider').expect(404);
    await fixture
      .get(
        `${fixture.environment}/applications/${otherApplication}/deployments/${deploymentId}/build-output`,
        'owner',
      )
      .expect(404);
    expect(asked).toEqual([]);
  });
});
