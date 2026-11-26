import { TestBed } from '@angular/core/testing';

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

  it('forgets one server’s containers when another is shown', async () => {
    const page = setup([lost]);
    await page.settle();
    page.fixture.componentRef.setInput('nodeId', OTHER);
    await page.settle();
    expect(page.text()).toBe('');
    expect(page.api.untrackedContainers).toHaveBeenLastCalledWith(ORG, OTHER);
  });
});
