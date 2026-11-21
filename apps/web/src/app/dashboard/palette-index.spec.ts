import { TestBed } from '@angular/core/testing';

import { AccessApi } from '../access/access-api';
import { DeliveryApi } from '../delivery/delivery-api';
import { FleetApi } from '../fleet/fleet-api';
import { IdentityRequestError } from '../identity/identity-api';
import { WorkspaceApi } from '../workspace/workspace-api';

import { PaletteIndex } from './palette-index';

const ORG = 'org-1';

describe('palette index (#271)', () => {
  function setup(overrides: { members?: () => Promise<unknown>; nodes?: () => Promise<unknown> }) {
    const forbidden = () => Promise.reject(new IdentityRequestError(404));
    const workspace = {
      projects: vi.fn(() =>
        Promise.resolve([
          { id: 'p1', name: 'Demo' },
          { id: 'p2', name: 'Hidden' },
        ]),
      ),
      environments: vi.fn((_org: string, project: string) =>
        project === 'p1' ? Promise.resolve([{ id: 'e1', name: 'production' }]) : forbidden(),
      ),
    };
    const delivery = {
      applications: vi.fn(() => Promise.resolve([{ id: 'a1', name: 'storefront' }])),
    };
    const fleet = {
      nodes: vi.fn(
        overrides.nodes ??
          (() =>
            Promise.resolve([
              { id: 'n1', name: 'node16', status: 'ready' },
              { id: 'n2', name: 'old', status: 'removed' },
            ])),
      ),
    };
    const access = {
      members: vi.fn(
        overrides.members ??
          (() => Promise.resolve({ items: [{ email: 'ada@example.com' }], nextCursor: null })),
      ),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceApi, useValue: workspace },
        { provide: DeliveryApi, useValue: delivery },
        { provide: FleetApi, useValue: fleet },
        { provide: AccessApi, useValue: access },
      ],
    });
    return TestBed.inject(PaletteIndex);
  }

  it('finds environments, applications, servers and members, with where they live', async () => {
    const entries = await setup({}).load(ORG);
    expect(entries.map((e) => [e.label, e.detail ?? null, e.link.join('/')])).toEqual([
      ['production', 'Demo', '/orgs/org-1/projects/p1/environments/e1'],
      [
        'storefront',
        'Demo · production',
        '/orgs/org-1/projects/p1/environments/e1/applications/a1',
      ],
      ['node16', null, '/orgs/org-1/servers'],
      ['ada@example.com', null, '/orgs/org-1/members'],
    ]);
    expect(entries.every((e) => e.raw)).toBe(true);
  });

  it('leaves out every list the account may not read', async () => {
    const forbidden = () => Promise.reject(new IdentityRequestError(403));
    const entries = await setup({ members: forbidden, nodes: forbidden }).load(ORG);
    expect(entries.map((e) => e.label)).toEqual(['production', 'storefront']);
  });
});
