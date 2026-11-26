import { TestBed } from '@angular/core/testing';

import { IdentityRequestError } from '../identity/identity-api';
import { I18n } from '../ui/i18n';

import { FleetApi, type UntrackedContainer } from './fleet-api';
import { UntrackedContainers } from './untracked-containers';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const NODE = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
const OTHER = '0190f5a8-7b1c-7e2d-8f3a-0000000000bc';
const lost: UntrackedContainer = {
  name: 'sk-billing-00000000a1b2-r2-0',
  containerId: 'e'.repeat(64),
  state: 'running',
  observedAt: '2026-11-26T15:00:00Z',
  application: { id: '0190f5a8-7b1c-7e2d-8f3a-00000000a1b2', name: 'billing' },
  projectId: '0190f5a8-7b1c-7e2d-8f3a-0000000000c1',
  environmentId: '0190f5a8-7b1c-7e2d-8f3a-0000000000d1',
  release: 2,
  replica: '0',
};

function setup(first: readonly UntrackedContainer[]) {
  const api = {
    untrackedContainers: vi.fn((_organizationId: string, nodeId: string) =>
      Promise.resolve(nodeId === NODE ? first : []),
    ),
    confirmContainerRemoval: vi.fn(
      (_organizationId: string, _nodeId: string, _container: string, _name: string) =>
        Promise.resolve('confirmation-token'),
    ),
    removeUntrackedContainer: vi.fn(
      (_organizationId: string, _nodeId: string, _name: string, _token: string) =>
        Promise.resolve(),
    ),
  };
  TestBed.configureTestingModule({
    imports: [UntrackedContainers],
    providers: [{ provide: FleetApi, useValue: api }],
  });
  TestBed.inject(I18n).use('en');
  const fixture = TestBed.createComponent(UntrackedContainers);
  fixture.componentRef.setInput('organizationId', ORG);
  fixture.componentRef.setInput('nodeId', NODE);
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
  return {
    api,
    fixture,
    settle,
    button,
    text: () => root().textContent.replace(/\s+/g, ' ').trim(),
    type: (value: string) => {
      const input = root().querySelector<HTMLInputElement>('#confirm-name');
      if (!input) throw new Error('no confirmation field');
      input.value = value;
      input.dispatchEvent(new Event('input'));
    },
  };
}

describe('untracked containers on the server page', () => {
  it('shows nothing while the server runs none', async () => {
    const page = setup([]);
    await page.settle();
    expect(page.text()).toBe('');
  });

  it('names each untracked container with its application and release', async () => {
    const page = setup([lost]);
    await page.settle();
    expect(page.text()).toContain('Untracked containers');
    expect(page.text()).toContain('sk-billing-00000000a1b2-r2-0');
    expect(page.text()).toContain('application billing · release 2');
    expect(page.text()).toContain('its volumes stay');
  });

  it('removes one on its typed name, then says the server removes it', async () => {
    const page = setup([lost]);
    await page.settle();
    page.button('Remove')?.click();
    await page.settle();
    expect(page.text()).toContain('The server stops and removes this container of billing.');
    page.type('sk-billing');
    await page.settle();
    expect(page.button('Remove the container')?.disabled).toBe(true);
    page.type(lost.name);
    await page.settle();
    page.button('Remove the container')?.click();
    await page.settle();
    expect(page.api.confirmContainerRemoval).toHaveBeenCalledWith(ORG, NODE, lost.name, lost.name);
    expect(page.api.removeUntrackedContainer).toHaveBeenCalledWith(
      ORG,
      NODE,
      lost.name,
      'confirmation-token',
    );
    expect(page.text()).toContain(`The server removes ${lost.name} within a minute.`);
    // It is not offered again while the server reports it.
    expect(page.button('Remove')).toBeUndefined();
  });

  it('keeps a removal asked out of the list while another is chosen or kept', async () => {
    const other: UntrackedContainer = { ...lost, name: 'sk-billing-00000000a1b2-r3-0', release: 3 };
    const page = setup([lost, other]);
    await page.settle();
    const root = page.fixture.nativeElement as HTMLElement;
    const offered = () =>
      [...root.querySelectorAll<HTMLButtonElement>('li button')].map((element) =>
        element.getAttribute('aria-label'),
      );
    root.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${lost.name}"]`)?.click();
    await page.settle();
    page.type(lost.name);
    await page.settle();
    page.button('Remove the container')?.click();
    await page.settle();
    // The server still reports both until it has removed the first.
    expect(offered()).toEqual([`Remove ${other.name}`]);
    page.button('Remove')?.click();
    await page.settle();
    expect(offered()).toEqual([`Remove ${other.name}`]);
    page.button('Keep it')?.click();
    await page.settle();
    expect(offered()).toEqual([`Remove ${other.name}`]);
  });

  it('offers a container again once the server reported it gone, then back', async () => {
    const page = setup([lost]);
    await page.settle();
    page.button('Remove')?.click();
    await page.settle();
    page.type(lost.name);
    await page.settle();
    page.button('Remove the container')?.click();
    await page.settle();
    expect(page.button('Remove')).toBeUndefined();
    page.api.untrackedContainers.mockImplementationOnce(() => Promise.resolve([]));
    await page.fixture.componentInstance.load();
    await page.settle();
    await page.fixture.componentInstance.load();
    await page.settle();
    expect(page.button('Remove')).toBeDefined();
  });

  it('forgets one server’s containers when another is shown', async () => {
    const page = setup([lost]);
    await page.settle();
    page.fixture.componentRef.setInput('nodeId', OTHER);
    await page.settle();
    expect(page.text()).toBe('');
    expect(page.api.untrackedContainers).toHaveBeenLastCalledWith(ORG, OTHER);
  });
  it('says when the list could not be read, and reads it again', async () => {
    const page = setup([lost]);
    page.api.untrackedContainers.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    await page.settle();
    expect(page.text()).toContain('The untracked containers could not be read.');
    page.button('Try again')?.click();
    await page.settle();
    expect(page.text()).not.toContain('could not be read');
    expect(page.text()).toContain(lost.name);
  });
  it('shows a refusal while the dialog is open, and offers to start again', async () => {
    const page = setup([lost]);
    page.api.removeUntrackedContainer.mockImplementationOnce(() =>
      Promise.reject(new IdentityRequestError(409, 0, { code: 'container_not_untracked' })),
    );
    await page.settle();
    page.button('Remove')?.click();
    await page.settle();
    page.type(lost.name);
    await page.settle();
    page.button('Remove the container')?.click();
    await page.settle();
    // The refusal is said, and the dialog cannot send a request the runner would drop.
    expect(page.button('Start again')).toBeDefined();
    expect(page.button('Remove the container')?.disabled).toBe(true);
    page.button('Start again')?.click();
    await page.settle();
    expect(page.button('Start again')).toBeUndefined();
    expect(page.api.untrackedContainers).toHaveBeenCalledTimes(2);
    expect(page.api.removeUntrackedContainer).toHaveBeenCalledTimes(1);
  });
});
