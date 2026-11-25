import { TestBed } from '@angular/core/testing';

import { I18n } from '../ui/i18n';

import { DeliveryApi, type EnvironmentRef, type ExecSession } from './delivery-api';
import { TerminalPanel } from './terminal-panel';
import type { Screen } from './terminal-view';

const environment: EnvironmentRef = {
  organizationId: '01900000-0000-7000-8000-000000000001',
  projectId: '01900000-0000-7000-8000-000000000002',
  environmentId: '01900000-0000-7000-8000-00000000000a',
};
const SHOP = '01900000-0000-7000-8000-0000000000a1';
const BLOG = '01900000-0000-7000-8000-0000000000a2';

/** A WebSocket the test opens, feeds and closes itself. */
class FakeSocket {
  static readonly OPEN = 1;
  static made: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  readonly sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: URL) {
    FakeSocket.made.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  opened(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown): void {
    this.onmessage?.({ data });
  }
  ended(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

/** The panel's own steps, as its buttons call them. */
interface Driven {
  connect(): Promise<void>;
  disconnect(): void;
  state(): string;
  screen(): Screen;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const session = {
  websocketPath: '/api/v1/exec/019d0000-0000-7000-8000-0000000000d1',
} as ExecSession;

function mount(open: () => Promise<ExecSession>) {
  const api = { openExecSession: vi.fn(open) };
  TestBed.configureTestingModule({
    imports: [TerminalPanel],
    providers: [{ provide: DeliveryApi, useValue: api }],
  });
  TestBed.inject(I18n).use('en');
  const fixture = TestBed.createComponent(TerminalPanel);
  fixture.componentRef.setInput('environment', environment);
  fixture.componentRef.setInput('applicationId', SHOP);
  fixture.componentRef.setInput('name', 'shop');
  fixture.detectChanges();
  const show = (applicationId: string) => {
    fixture.componentRef.setInput('applicationId', applicationId);
    fixture.detectChanges();
  };
  return { panel: fixture.componentInstance as unknown as Driven, api, show };
}

const notes = (screen: Screen) => screen.lines.filter((l) => l.kind === 'note').map((l) => l.text);

describe('the terminal panel', () => {
  beforeEach(() => {
    FakeSocket.made = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('closes its session when another application opens in the page', async () => {
    const { panel, show } = mount(() => Promise.resolve(session));
    await panel.connect();
    FakeSocket.made[0]?.opened();
    expect(panel.state()).toBe('open');
    show(BLOG);
    // What is typed now could otherwise reach the shop's shell under the blog's name.
    expect(FakeSocket.made[0]?.closed).toBe(true);
    expect(panel.state()).toBe('idle');
    expect(panel.screen().lines).toEqual([]);
  });

  it('does not join a session opened for the application left meanwhile', async () => {
    const opening = deferred<ExecSession>();
    const { panel, show } = mount(() => opening.promise);
    const connecting = panel.connect();
    expect(panel.state()).toBe('connecting');
    show(BLOG);
    opening.resolve(session);
    await connecting;
    expect(FakeSocket.made).toHaveLength(0);
    expect(panel.state()).toBe('idle');
  });

  it("never lets an ended session's close end a newer attempt", async () => {
    const second = deferred<ExecSession>();
    let calls = 0;
    const { panel, api } = mount(() => (++calls === 1 ? Promise.resolve(session) : second.promise));
    await panel.connect();
    const first = FakeSocket.made[0];
    first.opened();
    first.message('{"type":"exit","code":0}');
    expect(panel.state()).toBe('ended');
    void panel.connect();
    expect(panel.state()).toBe('connecting');
    // The server closes the first socket only now.
    first.ended();
    expect(panel.state()).toBe('connecting');
    expect(notes(panel.screen())).not.toContain('The session was closed.');
    void panel.connect();
    expect(api.openExecSession).toHaveBeenCalledTimes(2);
  });

  it("ends the session on the person's disconnect, with its note", async () => {
    const { panel } = mount(() => Promise.resolve(session));
    await panel.connect();
    const socket = FakeSocket.made[0];
    socket.opened();
    panel.disconnect();
    expect(socket.sent).toContain('{"type":"close","kill":true}');
    expect(socket.closed).toBe(true);
    expect(panel.state()).toBe('ended');
    expect(notes(panel.screen()).at(-1)).toBe('The session was closed.');
  });

  it('removes a color code that two frames split', async () => {
    const { panel } = mount(() => Promise.resolve(session));
    await panel.connect();
    const socket = FakeSocket.made[0];
    socket.opened();
    const frame = (text: string) => new Uint8Array([1, ...new TextEncoder().encode(text)]).buffer;
    socket.message(frame('ok \u001b[31'));
    socket.message(frame('merror\u001b[0m\n'));
    expect(
      panel
        .screen()
        .lines.filter((l) => l.kind === 'stdout')
        .map((l) => l.text),
    ).toEqual(['ok error']);
  });
});
