import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { appRoutes } from '../app.routes';
import { IDENTITY_FETCH } from '../identity/identity-api';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const PAGE = `/api/v1/organizations/${ORG}/audit-events`;
const CURSOR = '0190f5a8-7b1c-7e2d-8f3a-0000000000cc';
const event = (id: string, action = 'application.created', metadata: object = {}) => ({
  id,
  action,
  actorKind: 'user',
  actorId: 'account-1',
  ip: '192.0.2.1',
  targetType: 'application',
  targetId: 'target-1',
  metadata,
  createdAt: '2026-11-07T12:00:00.000Z',
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('audit page', () => {
  let harness: RouterTestingHarness;
  let urls: URL[];
  let answer: (url: URL) => Response | Promise<Response>;

  beforeEach(async () => {
    urls = [];
    answer = () => json({ items: [event('e1')], nextCursor: null });
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          appRoutes,
          withComponentInputBinding(),
          withRouterConfig({ paramsInheritanceStrategy: 'always' }),
        ),
        {
          provide: IDENTITY_FETCH,
          useValue: async (request: Request) => {
            const url = new URL(request.url);
            urls.push(url);
            return answer(url);
          },
        },
      ],
    });
    harness = await RouterTestingHarness.create();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function open(): Promise<void> {
    await harness.navigateByUrl(`/orgs/${ORG}/audit`);
    await settle();
    // The filters are folded away, as in the design; open them.
    button('Filter').click();
    await settle();
  }
  const rows = () => [
    ...element().querySelectorAll('[aria-label="Audit events"] button[aria-expanded]'),
  ];
  const listed = () => element().querySelector('[aria-label="Audit events"]')?.textContent ?? '';
  function element(): HTMLElement {
    const element = harness.routeNativeElement;
    if (!element) throw new Error('missing route');
    return element;
  }
  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await harness.fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    harness.fixture.detectChanges();
  }
  function fill(id: string, value: string): void {
    const input = element().querySelector<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(`missing ${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    harness.fixture.detectChanges();
  }
  async function apply(): Promise<void> {
    element()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  }
  function button(label: string): HTMLButtonElement {
    const found = [...element().querySelectorAll('button')].find((candidate) =>
      candidate.textContent.includes(label),
    );
    if (!found) throw new Error(`missing ${label}`);
    return found;
  }

  it('lists events and treats their metadata as text', async () => {
    answer = () =>
      json({
        items: [event('e1', 'application.created', { note: '<img src=x onerror=alert(1)>' })],
        nextCursor: null,
      });
    await open();
    const table = element().querySelector('[aria-label="Audit events"]');
    expect(table?.textContent).toContain('application.created');
    expect(table?.textContent).toContain('192.0.2.1');
    (rows()[0] as HTMLButtonElement | undefined)?.click();
    await settle();
    expect(table?.querySelector('pre')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(table?.querySelector('img')).toBeNull();
    expect(button('Apply filters').disabled).toBe(false);
  });

  it('sends only the filters that were filled, and the period in UTC', async () => {
    await open();
    fill('audit-action', 'deployment.created');
    fill('audit-from', '2026-11-07T10:00');
    await apply();
    const query = urls.at(-1)?.searchParams;
    expect(query?.get('action')).toBe('deployment.created');
    expect(query?.get('from')).toBe(new Date('2026-11-07T10:00').toISOString());
    expect(query?.has('targetId')).toBe(false);
    expect(query?.has('to')).toBe(false);
  });

  it('never sends a filter the API would refuse, or a reversed period', async () => {
    await open();
    const before = urls.length;
    for (const [id, value] of [
      ['audit-action', "x' OR 1=1 --"],
      ['audit-targetType', '../../etc'],
      ['audit-targetId', 'a b'],
      ['audit-actorId', '<script>'],
    ] as const) {
      fill(id, value);
      expect(button('Apply filters').disabled).toBe(true);
      await apply();
      fill(id, '');
    }
    fill('audit-from', '2026-11-07T10:00');
    fill('audit-to', '2026-11-07T09:00');
    expect(element().querySelector('#audit-period-error')).not.toBeNull();
    await apply();
    expect(urls).toHaveLength(before);
  });

  it('loads older events after the shown ones and keeps them when that fails', async () => {
    answer = (url) =>
      url.searchParams.has('cursor')
        ? json({ items: [event('e2', 'project.created')], nextCursor: null })
        : json({ items: [event('e1')], nextCursor: CURSOR });
    await open();
    button('Load older events').click();
    await settle();
    expect(urls.at(-1)?.searchParams.get('cursor')).toBe(CURSOR);
    const text = listed();
    expect(text).toContain('application.created');
    expect(text).toContain('project.created');
    expect(element().textContent).not.toContain('Load older events');

    answer = (url) =>
      url.searchParams.has('cursor')
        ? json({}, 500)
        : json({ items: [event('e1')], nextCursor: CURSOR });
    button('Clear').click();
    await settle();
    button('Load older events').click();
    await settle();
    expect(element().querySelector('[role="alert"]')).not.toBeNull();
    expect(listed()).toContain('application.created');
    expect(button('Load older events').disabled).toBe(false);
  });

  it('ignores an answer for filters that were replaced in the meantime', async () => {
    await open();
    let release: (response: Response) => void = () => undefined;
    answer = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    fill('audit-action', 'project.created');
    await apply();
    const stale = release;
    answer = () => json({ items: [event('e3', 'node.removed')], nextCursor: null });
    fill('audit-action', 'node.removed');
    await apply();
    stale(json({ items: [event('e4', 'project.created')], nextCursor: null }));
    await settle();
    const text = listed();
    expect(text).toContain('node.removed');
    expect(text).not.toContain('project.created');
  });

  it('explains a refusal, and an empty result', async () => {
    answer = () => json({}, 404);
    await open();
    expect(element().querySelector('[role="alert"]')).not.toBeNull();
    expect(rows()).toHaveLength(0);

    answer = () => json({ items: [], nextCursor: null });
    fill('audit-action', 'node.removed');
    await apply();
    expect(element().textContent).toContain('No events match these filters.');
    button('Clear').click();
    await settle();
    expect(element().textContent).toContain('Nothing has been recorded');
  });

  it('exports what the applied filters select and says when it was cut short', async () => {
    const create = vi.fn(() => 'blob:audit');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await open();
    fill('audit-action', 'project.created');
    await apply();
    fill('audit-action', 'typed.not_applied');
    answer = () =>
      new Response('{"id":"e1"}\n', {
        headers: { 'content-type': 'application/x-ndjson', 'x-shipkeep-truncated': 'true' },
      });
    button('Export as JSON Lines').click();
    await settle();
    const url = urls.at(-1);
    expect(url?.pathname).toBe(`${PAGE}/export`);
    expect(url?.searchParams.get('action')).toBe('project.created');
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(element().querySelector('[role="status"]')?.textContent).toContain('10,000');
    vi.unstubAllGlobals();
  });

  it('reports a failed export and saves nothing', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await open();
    answer = () => json({}, 500);
    button('Export as JSON Lines').click();
    await settle();
    expect(element().querySelector('[role="alert"]')).not.toBeNull();
    expect(click).not.toHaveBeenCalled();
    expect(rows().length).toBeGreaterThan(0);
  });
});
