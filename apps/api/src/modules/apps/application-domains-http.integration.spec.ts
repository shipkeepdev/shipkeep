import { create } from '@bufbuild/protobuf';
import { ContainerStatus_State, StateReportSchema } from '@shipkeep/proto-ts';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { AllocationObservations } from '../deployments/application/allocation-observations';
import { PIPELINE_STORE, type PipelineStore } from '../deployments/application/ports';

import {
  APPLICATION_STORE,
  type ApplicationStore,
  DOMAIN_RESOLVER,
  type DomainResolver,
} from './application/ports';

/** Fixed answers instead of the host's resolver; `undefined` is a failed lookup. */
const ANSWERS: Readonly<Record<string, readonly string[] | undefined>> = {
  'serving.example.com': ['8.8.8.8'],
  'partial.example.com': ['8.8.8.8', '1.1.1.1'],
  'foreign.example.com': ['9.9.9.9'],
  'internal.example.com': ['10.0.0.5'],
  'none.example.com': [],
  'failed.example.com': undefined,
};
const resolver: DomainResolver = {
  addresses: (hostname) => Promise.resolve(ANSWERS[hostname]),
};

const config = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  name: 'billing-api',
  build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
  run: { port: 3000 },
  secrets: ['DATABASE_URL'],
  ...overrides,
});

interface ApplicationBody {
  id: string;
  name: string;
  configSha: string;
  config: Record<string, unknown>;
}

/** PLAN M3.6a: a hostname belongs to one application per organization. */
describe('application domains over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  const path = () => `${fixture.environment}/applications`;

  beforeAll(async () => {
    fixture = await tenantHttpFixture([{ token: DOMAIN_RESOLVER, value: resolver }]);
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('refuses a claimed hostname, frees it on change and refuses wildcards', async () => {
    const first = (
      await fixture
        .post(path(), 'owner', {
          config: config({ name: 'first-app', domains: ['shared.example.com'] }),
        })
        .expect(201)
    ).body as ApplicationBody;
    await fixture
      .post(path(), 'owner', {
        config: config({ name: 'second-app', domains: ['shared.example.com'] }),
      })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'domain_taken',
          details: { hostname: 'shared.example.com' },
        });
      });
    // The refused application was rolled back with its claim.
    const listed = await fixture.get(path(), 'owner').expect(200);
    expect((listed.body as { items: { name: string }[] }).items.map((a) => a.name)).toEqual([
      'first-app',
    ]);
    await fixture
      .post(`${path()}/${first.id}/config`, 'owner', {
        expectedConfigSha: first.configSha,
        config: config({ name: 'first-app', domains: ['other.example.com'] }),
      })
      .expect(200);
    await fixture
      .post(path(), 'owner', {
        config: config({ name: 'second-app', domains: ['shared.example.com'] }),
      })
      .expect(201);
    await fixture
      .post(path(), 'owner', { config: config({ name: 'wild-app', domains: ['*.example.com'] }) })
      .expect(400);
  });

  it('keeps a dropped domain reserved while a placed release still serves it (#302)', async () => {
    const nodeId = await enrollTestNode(fixture, {
      facts: { hostname: 'edge-moving.example.com' },
      ready: false,
    });
    const first = (
      await fixture
        .post(path(), 'owner', {
          config: config({
            name: 'moving-from',
            domains: ['moving.example.com'],
            secrets: undefined,
          }),
        })
        .expect(201)
    ).body as ApplicationBody;
    const queued = await fixture.post(`${path()}/${first.id}/deployments`, 'owner', {}).expect(201);
    const { release, deployment } = queued.body as {
      release: { id: string };
      deployment: { id: string };
    };
    const releaseId = release.id;
    const tenant = <T>(work: () => Promise<T>) =>
      fixture.app.get(PrismaUnitOfWork).runTenant(fixture.organizationId, work);
    const pipeline = fixture.app.get<PipelineStore>(PIPELINE_STORE);
    const claim = () =>
      fixture.post(path(), 'owner', {
        config: config({ name: 'moving-to', domains: ['moving.example.com'], secrets: undefined }),
      });
    // A queued deployment, not placed yet, routes its snapshot once it runs: dropping the domain
    // from the configuration does not free it.
    const unplaced = (
      await fixture
        .post(`${path()}/${first.id}/config`, 'owner', {
          expectedConfigSha: first.configSha,
          config: config({ name: 'moving-from', domains: [], secrets: undefined }),
        })
        .expect(200)
    ).body as ApplicationBody;
    await claim().expect(409);
    const restored = (
      await fixture
        .post(`${path()}/${first.id}/config`, 'owner', {
          expectedConfigSha: unplaced.configSha,
          config: config({
            name: 'moving-from',
            domains: ['moving.example.com'],
            secrets: undefined,
          }),
        })
        .expect(200)
    ).body as ApplicationBody;
    first.configSha = restored.configSha;
    await tenant(() =>
      pipeline.place(
        fixture.organizationId,
        first.id,
        releaseId,
        [
          {
            index: 0,
            nodeId,
            container: 'sk-moving-from-0',
            port: 3000,
            cpuMillis: 0,
            memoryBytes: 0,
          },
        ],
        new Date(),
      ),
    );
    // Cancelled, the deployment routes nothing new, but its placed replica may still serve.
    await fixture
      .post(`${path()}/${first.id}/deployments/${deployment.id}/cancel`, 'owner', {})
      .expect(200);
    // The configuration drops the domain; the placed release still lists it, so its route may
    // still serve it.
    const dropped = (
      await fixture
        .post(`${path()}/${first.id}/config`, 'owner', {
          expectedConfigSha: first.configSha,
          config: config({ name: 'moving-from', domains: [], secrets: undefined }),
        })
        .expect(200)
    ).body as ApplicationBody;
    await claim()
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'domain_taken',
          details: { hostname: 'moving.example.com' },
        });
      });
    // Listing it again in the same application takes it back without a conflict.
    const again = (
      await fixture
        .post(`${path()}/${first.id}/config`, 'owner', {
          expectedConfigSha: dropped.configSha,
          config: config({
            name: 'moving-from',
            domains: ['moving.example.com'],
            secrets: undefined,
          }),
        })
        .expect(200)
    ).body as ApplicationBody;
    await fixture
      .post(`${path()}/${first.id}/config`, 'owner', {
        expectedConfigSha: again.configSha,
        config: config({ name: 'moving-from', domains: [], secrets: undefined }),
      })
      .expect(200);
    await claim().expect(409);
    // Once the replicas of that release are stopped, as the pipeline does when the next
    // deployment or a stop succeeds, nothing serves the domain and another application may take it.
    await tenant(async () => {
      await pipeline.stop(first.id, [releaseId], new Date());
      await fixture.app
        .get<ApplicationStore>(APPLICATION_STORE)
        .releaseUnservedDomains({ id: first.id, organizationId: fixture.organizationId });
    });
    await claim().expect(201);
  });

  it('says whether each domain reaches a node of the organization running the application', async () => {
    const enroll = (organizationId: string, hostname: string) =>
      enrollTestNode({ ...fixture, organizationId }, { facts: { hostname }, ready: false });
    const declare = (organizationId: string, nodeId: string, publicAddresses: string[]) =>
      fixture
        .post(`/api/v1/organizations/${organizationId}/nodes/${nodeId}/public-addresses`, 'owner', {
          publicAddresses,
        })
        .expect(200);
    const web = await enroll(fixture.organizationId, 'edge-web.example.com');
    const spare = await enroll(fixture.organizationId, 'edge-spare.example.com');
    // The fixture owner also owns the foreign organization: its node must never count here.
    const foreign = await enroll(fixture.foreignId, 'edge-foreign.example.com');
    await declare(fixture.organizationId, web, ['8.8.8.8', '8.8.4.4']);
    await declare(fixture.foreignId, foreign, ['9.9.9.9']);

    const created = await fixture
      .post(path(), 'owner', {
        // No secret, so the deployment can be queued.
        config: config({ name: 'matched-app', domains: Object.keys(ANSWERS), secrets: undefined }),
      })
      .expect(201);
    const applicationId = (created.body as ApplicationBody).id;
    const domains = async () => {
      const response = await fixture
        .get(`${path()}/${applicationId}/domains`, 'environmentViewer')
        .expect(200);
      const items = (response.body as { items: { hostname: string; match: string }[] }).items;
      // Only DNS answers are shown, never a node address that no answer names.
      expect(JSON.stringify(response.body)).not.toContain('8.8.4.4');
      return Object.fromEntries(items.map((item) => [item.hostname, item.match]));
    };
    expect(new Set(Object.values(await domains()))).toEqual(new Set(['not_running']));

    const queued = await fixture
      .post(`${path()}/${applicationId}/deployments`, 'owner', {})
      .expect(201);
    const releaseId = (queued.body as { release: { id: string } }).release.id;
    const place = (index: number, nodeId: string, container: string) =>
      fixture.app
        .get(PrismaUnitOfWork)
        .runTenant(fixture.organizationId, () =>
          fixture.app
            .get<PipelineStore>(PIPELINE_STORE)
            .place(
              fixture.organizationId,
              applicationId,
              releaseId,
              [{ index, nodeId, container, port: 3000, cpuMillis: 0, memoryBytes: 0 }],
              new Date(),
            ),
        );
    const observe = (nodeId: string, name: string, state: ContainerStatus_State) =>
      fixture.app
        .get(AllocationObservations)
        .record(
          { organizationId: fixture.organizationId, nodeId, serial: '' },
          create(StateReportSchema, { containers: [{ containerId: 'e'.repeat(64), name, state }] }),
        );

    // A placed replica counts only once its agent has seen it running.
    await place(0, web, 'sk-matched-app-web-0');
    expect((await domains())['serving.example.com']).toBe('not_running');
    await observe(web, 'sk-matched-app-web-0', ContainerStatus_State.RUNNING);
    expect(await domains()).toEqual({
      'serving.example.com': 'serving',
      'partial.example.com': 'partial',
      'foreign.example.com': 'elsewhere',
      'internal.example.com': 'elsewhere',
      'none.example.com': 'elsewhere',
      'failed.example.com': 'unknown',
    });

    // Another running node without a declared address makes unmatched answers undecidable.
    await place(1, spare, 'sk-matched-app-spare-1');
    await observe(spare, 'sk-matched-app-spare-1', ContainerStatus_State.RUNNING);
    expect(await domains()).toMatchObject({
      'serving.example.com': 'serving',
      'partial.example.com': 'unknown',
      'foreign.example.com': 'unknown',
      'none.example.com': 'elsewhere',
    });
    await observe(spare, 'sk-matched-app-spare-1', ContainerStatus_State.EXITED);
    await observe(web, 'sk-matched-app-web-0', ContainerStatus_State.EXITED);
    expect(new Set(Object.values(await domains()))).toEqual(new Set(['not_running']));

    await fixture.get(`${path()}/${applicationId}/domains`, 'outsider').expect(404);
  });
});
