import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { ShellContext } from '../shell/shell-context';
import { I18n } from '../ui/i18n';
import { WorkspaceApi } from '../workspace/workspace-api';

import { ApplicationPage } from './application-page';
import { type Application, DeliveryApi, type Release, type SecretMetadata } from './delivery-api';
import { LiveEvents } from './live-events';

const ORG = '01900000-0000-7000-8000-000000000001';
const PROJECT = '01900000-0000-7000-8000-000000000002';
const ENV_A = '01900000-0000-7000-8000-00000000000a';
const ENV_B = '01900000-0000-7000-8000-00000000000b';
const APP_A = '01900000-0000-7000-8000-0000000000a1';
const APP_B = '01900000-0000-7000-8000-0000000000b1';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const application = (id: string, name: string) =>
  ({
    id,
    name,
    source: 'image',
    config: {
      version: 1,
      name,
      build: { type: 'image', image: 'example.com/app:1' },
      run: { port: 80 },
    },
    configSha: 'sha',
    createdBy: null,
    createdAt: '2026-11-26T00:00:00.000Z',
  }) as unknown as Application;
const secret = (name: string) => ({ name, version: 1 }) as unknown as SecretMetadata;
const release = (id: string) => ({ id, number: 1 }) as unknown as Release;

/** What the page reads, held until the test answers each request. */
interface Pending {
  secrets: Deferred<readonly SecretMetadata[]>;
  releases: Deferred<readonly Release[]>;
  environment: Deferred<unknown>;
}

/** The state the page holds, read the way its template reads it. */
interface Held {
  secrets(): readonly SecretMetadata[];
  releases(): readonly Release[];
  environmentInfo(): { name: string } | null;
  application(): Application | null;
}

function mount() {
  const pending = new Map<string, Pending>();
  const pendingFor = (environmentId: string, applicationId: string) => {
    const key = `${environmentId}/${applicationId}`;
    let entry = pending.get(key);
    if (!entry) {
      entry = { secrets: deferred(), releases: deferred(), environment: deferred() };
      pending.set(key, entry);
    }
    return entry;
  };
  // The environment's requests are keyed by the application loaded with it.
  let currentApp = APP_A;
  /** Any other call answers an empty list, as an idle API would. */
  const orEmpty = (methods: Record<string, unknown>) =>
    new Proxy(methods, {
      get: (target, name: string): unknown => target[name] ?? (() => Promise.resolve([])),
    });
  const api = orEmpty({
    application: (_environment: unknown, id: string) => {
      currentApp = id;
      return Promise.resolve(application(id, id === APP_A ? 'alpha' : 'bravo'));
    },
    secrets: (environment: { environmentId: string }) =>
      pendingFor(environment.environmentId, currentApp).secrets.promise,
    releases: (environment: { environmentId: string }, id: string) =>
      pendingFor(environment.environmentId, id).releases.promise,
  });
  const workspace = orEmpty({
    environment: (_organization: string, _project: string, environmentId: string) =>
      pendingFor(environmentId, currentApp).environment.promise,
  });
  TestBed.configureTestingModule({
    imports: [ApplicationPage],
    providers: [
      provideRouter([]),
      { provide: DeliveryApi, useValue: api },
      { provide: WorkspaceApi, useValue: workspace },
      {
        provide: LiveEvents,
        useValue: { connected: signal(false), connect: () => ({ close: () => undefined }) },
      },
      {
        provide: ShellContext,
        useValue: new Proxy<Record<string, unknown>>(
          { names: signal(new Map()), projects: signal([]) },
          { get: (target, name: string): unknown => target[name] ?? signal(null) },
        ),
      },
    ],
  });
  TestBed.inject(I18n).use('en');
  const fixture = TestBed.createComponent(ApplicationPage);
  const show = (environmentId: string, applicationId: string) => {
    fixture.componentRef.setInput('organizationId', ORG);
    fixture.componentRef.setInput('projectId', PROJECT);
    fixture.componentRef.setInput('environmentId', environmentId);
    fixture.componentRef.setInput('applicationId', applicationId);
    fixture.detectChanges();
  };
  const page = fixture.componentInstance as unknown as Held;
  return { show, page, pendingFor, fixture };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Issue #491: a late answer for the application left never shows under the one opened next.
describe('the application page across navigation', () => {
  it('keeps B’s data when A’s answers arrive last, successes and failures alike', async () => {
    const { show, page, pendingFor } = mount();
    show(ENV_A, APP_A);
    await settle();
    const a = pendingFor(ENV_A, APP_A);
    show(ENV_B, APP_B);
    await settle();
    // A’s data went at once: nothing of A is shown while B loads.
    expect(page.secrets()).toEqual([]);
    expect(page.environmentInfo()).toBeNull();
    const b = pendingFor(ENV_B, APP_B);
    b.secrets.resolve([secret('B_SECRET')]);
    b.releases.resolve([release('release-b')]);
    b.environment.resolve({ name: 'env-b' });
    await settle();
    a.secrets.resolve([secret('A_SECRET')]);
    a.releases.reject(new Error('late failure'));
    a.environment.resolve({ name: 'env-a' });
    await settle();
    expect(page.application()?.id).toBe(APP_B);
    expect(page.secrets().map((s) => s.name)).toEqual(['B_SECRET']);
    expect(page.releases().map((r) => r.id)).toEqual(['release-b']);
    expect(page.environmentInfo()?.name).toBe('env-b');
  });

  it('drops a late failure of A instead of clearing B', async () => {
    const { show, page, pendingFor } = mount();
    show(ENV_A, APP_A);
    await settle();
    const a = pendingFor(ENV_A, APP_A);
    show(ENV_B, APP_B);
    await settle();
    const b = pendingFor(ENV_B, APP_B);
    b.secrets.resolve([secret('B_SECRET')]);
    b.environment.resolve({ name: 'env-b' });
    await settle();
    a.secrets.reject(new Error('late failure'));
    a.environment.reject(new Error('late failure'));
    await settle();
    expect(page.secrets().map((s) => s.name)).toEqual(['B_SECRET']);
    expect(page.environmentInfo()?.name).toBe('env-b');
  });

  it('ignores every answer once the page is gone', async () => {
    const { show, page, pendingFor, fixture } = mount();
    show(ENV_A, APP_A);
    await settle();
    const a = pendingFor(ENV_A, APP_A);
    fixture.destroy();
    a.secrets.resolve([secret('A_SECRET')]);
    a.releases.resolve([release('release-a')]);
    a.environment.resolve({ name: 'env-a' });
    await settle();
    expect(page.secrets()).toEqual([]);
    expect(page.releases()).toEqual([]);
    expect(page.environmentInfo()).toBeNull();
  });

  it('keeps the latest release list when an older refresh answers last', async () => {
    const { show, page } = mount();
    const first = deferred<readonly Release[]>();
    const second = deferred<readonly Release[]>();
    const api = TestBed.inject(DeliveryApi) as unknown as Record<string, unknown>;
    show(ENV_A, APP_A);
    await settle();
    const refreshes = [first, second];
    api['releases'] = () => refreshes.shift()?.promise ?? Promise.resolve([]);
    const reload = page as unknown as { loadReleases(environment: unknown, id: string): void };
    const environment = { organizationId: ORG, projectId: PROJECT, environmentId: ENV_A };
    reload.loadReleases(environment, APP_A);
    reload.loadReleases(environment, APP_A);
    second.resolve([release('newer')]);
    await settle();
    first.resolve([release('older')]);
    await settle();
    expect(page.releases().map((r) => r.id)).toEqual(['newer']);
  });
});
