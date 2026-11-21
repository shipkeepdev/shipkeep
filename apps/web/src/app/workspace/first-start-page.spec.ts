import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { ShellContext } from '../shell/shell-context';
import { I18n } from '../ui/i18n';

import { type FirstStartFacts, FirstStartPage, firstStartSteps } from './first-start-page';
import { FirstStartStore } from './first-start-store';
import { WorkspaceApi } from './workspace-api';

const ORG = '01900000-0000-7000-8000-000000000001';
const empty: FirstStartFacts = {
  organization: 'Local Test',
  role: 'owner',
  servers: 0,
  readyServers: 0,
  registries: 0,
  applications: 0,
  deployed: false,
};

// The language is kept in localStorage: put it back, or later files read French.
afterEach(() => {
  try {
    localStorage.removeItem('shipkeep-lang');
  } catch {
    // No storage: nothing was kept.
  }
});

describe('first start steps (#269)', () => {
  it('ticks only what the API reports', () => {
    expect(firstStartSteps(ORG, empty).map((s) => s.done)).toEqual([true, false, false, false]);
    const running = { ...empty, servers: 2, readyServers: 1, applications: 1, deployed: true };
    expect(firstStartSteps(ORG, running).map((s) => s.done)).toEqual([true, true, true, true]);
    // A stored registry is enough for the source step, an application without deployment is not.
    const half = { ...empty, servers: 1, registries: 1, applications: 1 };
    expect(firstStartSteps(ORG, half).map((s) => s.done)).toEqual([true, true, true, false]);
  });

  it('neither ticks nor opens a step it could not read', () => {
    const unread = { ...empty, servers: null, applications: null, deployed: null };
    expect(firstStartSteps(ORG, unread).map((s) => s.done)).toEqual([true, null, null, null]);
    // A stored registry still settles the source step on its own.
    expect(firstStartSteps(ORG, { ...unread, registries: 1 }).at(2)?.done).toBe(true);
    expect(firstStartSteps(ORG, unread).at(1)?.detail).toBe('Could not be read right now.');
  });

  it('links each step to where it is done', () => {
    const [, server, source, deploy] = firstStartSteps(ORG, empty);
    expect(server.cta?.link).toEqual(['/orgs', ORG, 'servers']);
    expect(source.cta).toMatchObject({
      link: ['/orgs', ORG, 'organization'],
      section: 'registries',
    });
    expect(deploy.cta?.link).toEqual(['/orgs', ORG, 'new']);
    const withApp = firstStartSteps(ORG, { ...empty, applications: 1 }).at(3);
    expect(withApp?.cta?.link).toEqual(['/orgs', ORG, 'applications']);
  });
});

describe('first start page', () => {
  async function render(role: string) {
    const store = {
      loading: signal(false),
      facts: signal({ servers: 1, readyServers: 1, applications: 0, deployed: false }),
      load: vi.fn(() => Promise.resolve()),
    };
    const registries = vi.fn(() => Promise.resolve([]));
    TestBed.configureTestingModule({
      imports: [FirstStartPage],
      providers: [
        provideRouter([]),
        { provide: WorkspaceApi, useValue: { registries } },
        {
          provide: ShellContext,
          useValue: { organization: signal({ name: 'Local Test' }), role: signal(role) },
        },
      ],
    });
    TestBed.overrideComponent(FirstStartPage, {
      set: { providers: [{ provide: FirstStartStore, useValue: store }] },
    });
    TestBed.inject(I18n).use('fr');
    const fixture = TestBed.createComponent(FirstStartPage);
    fixture.componentRef.setInput('organizationId', ORG);
    await fixture.whenStable();
    fixture.detectChanges();
    return { store, registries, element: fixture.nativeElement as HTMLElement };
  }

  it('marks the next step and counts the done ones, in French too', async () => {
    const { store, registries, element } = await render('owner');
    expect(store.load).toHaveBeenCalledWith(ORG);
    expect(element.textContent).toContain('2 sur 4 faites');
    expect(element.textContent).toContain('vous êtes Propriétaire');
    expect(element.textContent).toContain('1 serveur inscrit, 1 prêt.');
    const current = element.querySelector('[aria-current=step]');
    expect(current?.textContent).toContain("Choisir d'où viennent les images");
    // An owner may read registries; the step counts them.
    expect(registries).toHaveBeenCalledWith(ORG);
  });

  it('never asks for registries a member may not read', async () => {
    const { registries } = await render('member');
    expect(registries).not.toHaveBeenCalled();
  });
});
