import { TestBed } from '@angular/core/testing';

import { IdentityRequestError } from '../identity/identity-api';
import { I18n } from '../ui/i18n';

import { FleetApi, type FleetNode, type NodeReadoption } from './fleet-api';
import { NodeReadoptions } from './node-readoptions';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const OTHER = '0190f5a8-7b1c-7e2d-8f3a-0000000000ab';
const A = '0190f5a8-7b1c-7e2d-8f3a-00000000000a';
const B = '0190f5a8-7b1c-7e2d-8f3a-00000000000b';
const node = (id: string, name: string) => ({ id, name }) as FleetNode;
const waiting: NodeReadoption = {
  nodeId: A,
  certificateSerial: '2b4c154c74bd8eb6673868837090c845',
  certificateNotAfter: '2026-12-26T13:38:04Z',
  firstSeenAt: '2026-11-26T14:32:06Z',
  lastSeenAt: '2026-11-26T14:37:06Z',
};

function setup(first: readonly NodeReadoption[]) {
  let current = first;
  const api = {
    readoptions: vi.fn((organizationId: string) =>
      Promise.resolve(organizationId === ORG ? current : []),
    ),
    readopt: vi.fn((_organizationId: string, _nodeId: string, _body: unknown) => {
      current = [];
      return Promise.resolve();
    }),
  };
  TestBed.configureTestingModule({
    imports: [NodeReadoptions],
    providers: [{ provide: FleetApi, useValue: api }],
  });
  TestBed.inject(I18n).use('en');
  const fixture = TestBed.createComponent(NodeReadoptions);
  fixture.componentRef.setInput('organizationId', ORG);
  fixture.componentRef.setInput('nodes', [node(A, 'edge-a')]);
  let changed = 0;
  fixture.componentInstance.changed.subscribe(() => changed++);
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      fixture.detectChanges();
    }
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const button = (label: string) =>
    [...root().querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent.trim() === label,
    );
  const type = (id: string, value: string) => {
    const input = root().querySelector<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(`no #${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  return {
    api,
    fixture,
    settle,
    button,
    type,
    text: () => root().textContent.replace(/\s+/g, ' ').trim(),
    changed: () => changed,
    set: (next: readonly NodeReadoption[]) => {
      current = next;
    },
  };
}

describe('servers to re-adopt on the Servers page', () => {
  it('shows nothing while no server waits', async () => {
    const page = setup([]);
    await page.settle();
    expect(page.text()).toBe('');
  });

  it('names the waiting server, and re-adopts it after the password', async () => {
    const page = setup([waiting]);
    await page.settle();
    expect(page.text()).toContain('Servers to re-adopt');
    expect(page.text()).toContain('edge-a');
    expect(page.text()).toContain('Their applications keep running.');
    page.button('Re-adopt')?.click();
    await page.settle();
    const submit = page.button('Re-adopt edge-a');
    expect(submit?.disabled).toBe(true);
    page.type('readopt-password', 'a fixture password, long enough');
    page.type('readopt-totp', ' 123456 ');
    await page.settle();
    expect(submit?.disabled).toBe(false);
    submit?.click();
    await page.settle();
    expect(page.api.readopt).toHaveBeenCalledWith(ORG, A, {
      password: 'a fixture password, long enough',
      totp: '123456',
    });
    expect(page.text()).toContain(
      'edge-a is re-adopted: it connects again within 5 minutes, or once its agent is restarted if it runs 0.1.0-alpha.7 or earlier.',
    );
    expect(page.text()).not.toContain('Re-adopt edge-a');
    expect(page.changed()).toBe(1);
  });

  it('sends no empty second factor, and keeps the server listed when the proof is refused', async () => {
    const page = setup([waiting]);
    page.api.readopt.mockImplementationOnce(() =>
      Promise.reject(new IdentityRequestError(401, 0, { code: 'invalid_credentials' })),
    );
    await page.settle();
    page.button('Re-adopt')?.click();
    await page.settle();
    page.type('readopt-password', 'a wrong fixture password, long enough');
    await page.settle();
    page.button('Re-adopt edge-a')?.click();
    await page.settle();
    expect(page.api.readopt).toHaveBeenCalledWith(ORG, A, {
      password: 'a wrong fixture password, long enough',
    });
    expect(page.text()).toContain('edge-a');
    expect(page.text()).not.toContain('is re-adopted');
    expect(page.changed()).toBe(0);
  });

  it('forgets one organization’s servers when another is shown', async () => {
    const page = setup([waiting]);
    await page.settle();
    page.fixture.componentRef.setInput('organizationId', OTHER);
    await page.settle();
    expect(page.text()).toBe('');
    expect(page.api.readoptions).toHaveBeenLastCalledWith(OTHER);
  });
  it('says when the list could not be read, keeps what was read, and reads it again', async () => {
    const page = setup([waiting]);
    page.api.readoptions.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    await page.settle();
    expect(page.text()).toContain('The servers to re-adopt could not be read.');
    page.button('Try again')?.click();
    await page.settle();
    expect(page.text()).not.toContain('could not be read');
    expect(page.text()).toContain('edge-a');
    // A later failure keeps the server listed, with the error.
    page.api.readoptions.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    await page.fixture.componentInstance.load();
    await page.settle();
    expect(page.text()).toContain('edge-a');
    expect(page.text()).toContain('The servers to re-adopt could not be read.');
  });

  it('leaves a password typed for another organization alone when an earlier answer comes', async () => {
    const page = setup([waiting]);
    let answer: () => void = () => undefined;
    page.api.readopt.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    page.api.readoptions.mockImplementation((organizationId: string) =>
      Promise.resolve(organizationId === OTHER ? [{ ...waiting, nodeId: B }] : [waiting]),
    );
    await page.settle();
    page.button('Re-adopt')?.click();
    await page.settle();
    page.type('readopt-password', 'a fixture password, long enough');
    await page.settle();
    page.button('Re-adopt edge-a')?.click();
    await page.settle();
    // Another organization, while the first answer is still on its way.
    page.fixture.componentRef.setInput('organizationId', OTHER);
    page.fixture.componentRef.setInput('nodes', [node(B, 'edge-b')]);
    await page.settle();
    page.button('Re-adopt')?.click();
    await page.settle();
    page.type('readopt-password', 'typed for the other organization');
    answer();
    await page.settle();
    const field = (page.fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      '#readopt-password',
    );
    expect(field?.value).toBe('typed for the other organization');
  });
  it('offers to start again after a refusal that needs a fresh attempt', async () => {
    const page = setup([waiting]);
    page.api.readopt.mockImplementationOnce(() =>
      Promise.reject(new IdentityRequestError(409, 0, { code: 'readoption_certificate_expired' })),
    );
    await page.settle();
    page.button('Re-adopt')?.click();
    await page.settle();
    page.type('readopt-password', 'a fixture password, long enough');
    await page.settle();
    page.button('Re-adopt edge-a')?.click();
    await page.settle();
    expect(page.button('Start again')).toBeDefined();
    // Typing again does not make a send that the runner would silently drop.
    page.type('readopt-password', 'a fixture password, long enough');
    await page.settle();
    expect(page.button('Re-adopt edge-a')?.disabled).toBe(true);
    page.button('Start again')?.click();
    await page.settle();
    page.type('readopt-password', 'a fixture password, long enough');
    await page.settle();
    expect(page.button('Re-adopt edge-a')?.disabled).toBe(false);
    expect(page.api.readopt).toHaveBeenCalledTimes(1);
  });

  it('forgets the typed password when its server no longer waits', async () => {
    const page = setup([waiting]);
    await page.settle();
    page.button('Re-adopt')?.click();
    await page.settle();
    page.type('readopt-password', 'a fixture password, long enough');
    await page.settle();
    // Another administrator re-adopted it meanwhile.
    page.set([]);
    await page.fixture.componentInstance.load();
    await page.settle();
    expect(page.text()).toBe('');
    const state = page.fixture.componentInstance as unknown as {
      proof: { getRawValue(): { password: string } };
    };
    expect(state.proof.getRawValue().password).toBe('');
  });
});
