import { TestBed } from '@angular/core/testing';

import { DeliveryApi, type EnvironmentRef } from '../delivery/delivery-api';
import { FleetApi } from '../fleet/fleet-api';

import { FirstStartStore } from './first-start-store';
import { WorkspaceApi } from './workspace-api';

const ORG = 'org-1';

describe('first start facts (#269)', () => {
  function setup(
    served: (id: string) => boolean,
    fail = false,
    unreadable: (id: string) => boolean = () => false,
  ) {
    const ids = Array.from({ length: 45 }, (_, i) => `a${String(i + 1)}`);
    const deployments = vi.fn((_ref: EnvironmentRef, id: string) =>
      unreadable(id)
        ? Promise.reject(new Error('down'))
        : Promise.resolve(
            served(id) ? [{ state: 'succeeded', stop: false }] : [{ state: 'failed' }],
          ),
    );
    const registries = vi.fn(() => Promise.resolve([{ id: 'r1' }, { id: 'r2' }]));
    TestBed.configureTestingModule({
      providers: [
        FirstStartStore,
        {
          provide: WorkspaceApi,
          useValue: {
            projects: () => Promise.resolve([{ id: 'p1' }]),
            environments: () => Promise.resolve([{ id: 'e1' }]),
            registries,
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
    return { store: TestBed.inject(FirstStartStore), deployments, registries };
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

  it('keeps a deployment that served when another list fails', async () => {
    const { store } = setup(
      (id) => id === 'a2',
      false,
      (id) => id === 'a1',
    );
    await store.load(ORG);
    expect(store.facts().deployed).toBe(true);
  });

  it('looks past a failed batch, and says unread only when nothing served', async () => {
    const found = setup(
      (id) => id === 'a20',
      false,
      (id) => id === 'a1',
    );
    await found.store.load(ORG);
    expect(found.store.facts().deployed).toBe(true);
    TestBed.resetTestingModule();
    const none = setup(
      () => false,
      false,
      (id) => id === 'a1',
    );
    await none.store.load(ORG);
    expect(none.store.facts().deployed).toBeNull();
  });

  it('reads registries for owners and admins only, and counts a failed read as none', async () => {
    const { store, registries } = setup(() => false);
    store.readRegistries(ORG, 'member');
    expect(registries).not.toHaveBeenCalled();
    expect(store.registries()).toBe(0);
    store.readRegistries(ORG, 'admin');
    await vi.waitFor(() => {
      expect(store.registries()).toBe(2);
    });
    expect(registries).toHaveBeenCalledWith(ORG);
    registries.mockRejectedValueOnce(new Error('down'));
    store.readRegistries(ORG, 'owner');
    expect(store.registries()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve));
    expect(store.registries()).toBe(0);
  });
});
