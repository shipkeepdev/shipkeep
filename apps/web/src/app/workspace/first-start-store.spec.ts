import { TestBed } from '@angular/core/testing';

import { DeliveryApi, type EnvironmentRef } from '../delivery/delivery-api';
import { FleetApi } from '../fleet/fleet-api';

import { FirstStartStore } from './first-start-store';
import { WorkspaceApi } from './workspace-api';

const ORG = 'org-1';

describe('first start facts (#269)', () => {
  function setup(served: (id: string) => boolean, fail = false) {
    const ids = Array.from({ length: 45 }, (_, i) => `a${String(i + 1)}`);
    const deployments = vi.fn((_ref: EnvironmentRef, id: string) =>
      Promise.resolve(served(id) ? [{ state: 'succeeded', stop: false }] : [{ state: 'failed' }]),
    );
    TestBed.configureTestingModule({
      providers: [
        FirstStartStore,
        {
          provide: WorkspaceApi,
          useValue: {
            projects: () => Promise.resolve([{ id: 'p1' }]),
            environments: () => Promise.resolve([{ id: 'e1' }]),
          },
        },
        {
          provide: DeliveryApi,
          useValue: {
            applications: () =>
              fail ? Promise.reject(new Error('down')) : Promise.resolve(ids.map((id) => ({ id }))),
            deployments,
          },
        },
        { provide: FleetApi, useValue: { nodes: () => Promise.resolve([{ status: 'ready' }]) } },
      ],
    });
    return { store: TestBed.inject(FirstStartStore), deployments };
  }

  it('reads every application, past the Overview’s forty', async () => {
    const { store } = setup((id) => id === 'a45');
    await store.load(ORG);
    expect(store.facts()).toEqual({
      servers: 1,
      readyServers: 1,
      applications: 45,
      deployed: true,
    });
  });

  it('stops looking once an application served', async () => {
    const { store, deployments } = setup((id) => id === 'a2');
    await store.load(ORG);
    expect(store.facts().deployed).toBe(true);
    expect(deployments.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('says it could not read the applications rather than none', async () => {
    const { store } = setup(() => false, true);
    await store.load(ORG);
    expect(store.facts()).toMatchObject({ servers: 1, applications: null, deployed: null });
  });
});
