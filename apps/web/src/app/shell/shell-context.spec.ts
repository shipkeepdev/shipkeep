import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';

import { AccessApi, type Member } from '../access/access-api';
import { FleetApi } from '../fleet/fleet-api';
import { IdentityApi } from '../identity/identity-api';
import { WorkspaceApi } from '../workspace/workspace-api';

import { ShellContext } from './shell-context';

const ORG = '01900000-0000-7000-8000-000000000001';
const member = (n: number, displayName: string | null = null): Member => ({
  id: `m${String(n)}`,
  userId: `u${String(n)}`,
  email: `p${String(n)}@example.com`,
  displayName,
  orgRole: 'member',
  active: true,
  organizationId: ORG,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
});

describe('shell context', () => {
  it('names every member, past the first page (#251)', async () => {
    const members = vi.fn((_org: string, cursor?: string) =>
      Promise.resolve(
        cursor
          ? { items: [member(2, 'Grace Hopper')], nextCursor: null }
          : { items: [member(1, 'Ada Lovelace')], nextCursor: 'm1' },
      ),
    );
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { url: `/orgs/${ORG}`, events: new Subject() } },
        {
          provide: WorkspaceApi,
          useValue: {
            organization: () => Promise.resolve({ id: ORG, name: 'Local Test' }),
            projects: () => Promise.resolve([]),
            organizations: () => Promise.resolve([]),
          },
        },
        { provide: FleetApi, useValue: { nodes: () => Promise.resolve([]) } },
        { provide: AccessApi, useValue: { members } },
        {
          provide: IdentityApi,
          useValue: {
            mfaStatus: () => Promise.reject(new Error('n/a')),
            health: () => Promise.reject(new Error('n/a')),
            session: () => Promise.reject(new Error('n/a')),
          },
        },
      ],
    });
    const shell = TestBed.inject(ShellContext);
    await shell.refresh();
    expect(members).toHaveBeenCalledTimes(2);
    expect(members).toHaveBeenLastCalledWith(ORG, 'm1');
    expect(shell.members()).toBe(2);
    expect(shell.names().get('u1')).toBe('Ada Lovelace');
    expect(shell.names().get('u2')).toBe('Grace Hopper');
  });
});
