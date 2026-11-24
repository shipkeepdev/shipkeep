import { TestBed } from '@angular/core/testing';

import { IdentityRequestError } from '../identity/identity-api';
import { I18n } from '../ui/i18n';

import { AgentUpgrades, POLL_MS } from './agent-upgrades';
import {
  type AgentUpgrade,
  type AgentUpgradeOverview,
  FleetApi,
  type FleetNode,
} from './fleet-api';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const OTHER = '0190f5a8-7b1c-7e2d-8f3a-0000000000ab';
const A = '0190f5a8-7b1c-7e2d-8f3a-00000000000a';
const B = '0190f5a8-7b1c-7e2d-8f3a-00000000000b';
const node = (id: string, name: string) => ({ id, name }) as FleetNode;
const rollout = (changes: Partial<AgentUpgrade>): AgentUpgrade => ({
  id: '0190f5a8-7b1c-7e2d-8f3a-0000000000f1',
  version: '0.2.0',
  state: 'running',
  nodeIds: [A, B],
  position: 0,
  failure: null,
  createdAt: '2026-11-24T10:00:00Z',
  updatedAt: '2026-11-24T10:00:00Z',
  completedAt: null,
  ...changes,
});

function setup(first: AgentUpgradeOverview) {
  let current = first;
  const api = {
    agentUpgrades: vi.fn((organizationId: string) =>
      Promise.resolve(
        organizationId === ORG ? current : { version: '0.2.0', pending: [], rollout: null },
      ),
    ),
    startAgentUpgrade: vi.fn((_organizationId: string, _version: string) =>
      Promise.resolve(rollout({})),
    ),
  };
  TestBed.configureTestingModule({
    imports: [AgentUpgrades],
    providers: [{ provide: FleetApi, useValue: api }],
  });
  TestBed.inject(I18n).use('en');
  const fixture = TestBed.createComponent(AgentUpgrades);
  fixture.componentRef.setInput('organizationId', ORG);
  fixture.componentRef.setInput('nodes', [node(A, 'edge-a'), node(B, 'edge-b')]);
  let ended = 0;
  fixture.componentInstance.rolloutEnded.subscribe(() => ended++);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      fixture.detectChanges();
    }
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return {
    api,
    fixture,
    settle,
    set: (next: AgentUpgradeOverview) => {
      current = next;
    },
    text: () => (fixture.nativeElement as HTMLElement).textContent.replace(/\s+/g, ' ').trim(),
    button: () => (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button'),
    ended: () => ended,
  };
}

describe('agent upgrades on the Servers page', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says nothing on a development build', async () => {
    const t = setup({ version: null, pending: [A], rollout: null });
    await t.settle();
    expect(t.text()).toBe('');
  });

  it('offers to upgrade the servers on an older release, with the version it saw', async () => {
    const t = setup({ version: '0.2.0', pending: [A, B], rollout: null });
    await t.settle();
    expect(t.text()).toContain('2 servers run an older agent than the control plane, 0.2.0.');
    t.set({ version: '0.2.0', pending: [A, B], rollout: rollout({}) });
    t.button()?.click();
    await t.settle();
    expect(t.api.startAgentUpgrade).toHaveBeenCalledWith(ORG, '0.2.0');
    expect(t.text()).toContain('Upgrading agents to 0.2.0: server 1 of 2, edge-a.');
    expect(t.button()).toBeNull();
  });

  it('polls a running rollout every few seconds, and stops once it ended', async () => {
    vi.useFakeTimers();
    const t = setup({ version: '0.2.0', pending: [A, B], rollout: rollout({}) });
    await t.settle();
    expect(t.api.agentUpgrades).toHaveBeenCalledTimes(1);
    t.set({ version: '0.2.0', pending: [B], rollout: rollout({ position: 1 }) });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await t.settle();
    expect(t.api.agentUpgrades).toHaveBeenCalledTimes(2);
    expect(t.text()).toContain('server 2 of 2, edge-b.');
    expect(t.text()).toMatch(/edge-a upgraded.*edge-b upgrading/);

    t.set({ version: '0.2.0', pending: [], rollout: rollout({ state: 'succeeded', position: 2 }) });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await t.settle();
    expect(t.text()).toBe('');
    expect(t.ended()).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(t.api.agentUpgrades).toHaveBeenCalledTimes(3);
  });

  it('stops polling when the page goes away', async () => {
    vi.useFakeTimers();
    const t = setup({ version: '0.2.0', pending: [A, B], rollout: rollout({}) });
    await t.settle();
    t.fixture.destroy();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(t.api.agentUpgrades).toHaveBeenCalledTimes(1);
  });

  it('says where and why the last rollout stopped, and offers to try again', async () => {
    const t = setup({
      version: '0.2.0',
      pending: [B],
      rollout: rollout({
        state: 'failed',
        position: 1,
        failure: { nodeId: B, reason: 'rolled_back', actionReason: null },
        completedAt: '2026-11-24T10:20:00Z',
      }),
    });
    await t.settle();
    expect(t.text()).toContain('The upgrade stopped at edge-b.');
    expect(t.text()).toContain(
      'The new agent did not start on edge-b: the previous version is back.',
    );
    expect(t.text()).toMatch(/edge-a upgraded.*edge-b upgrade stopped/);
    expect(t.button()?.textContent).toContain('Upgrade agents');
  });

  it('explains a refused start in the words of its reason, in French too', async () => {
    const t = setup({ version: '0.2.0', pending: [A], rollout: null });
    t.api.startAgentUpgrade.mockRejectedValueOnce(
      new IdentityRequestError(409, 0, { code: 'agent_upgrade_version_changed' }),
    );
    TestBed.inject(I18n).use('fr');
    await t.settle();
    t.button()?.click();
    await t.settle();
    expect(t.text()).toContain(
      'Le plan de contrôle a été mis à jour entre-temps. Rechargez la page et réessayez.',
    );
    // The refusal was explained: the button works again.
    expect(t.button()?.disabled).toBe(false);
  });

  it("never shows one organization's rollout under another", async () => {
    const t = setup({ version: '0.2.0', pending: [A, B], rollout: rollout({}) });
    await t.settle();
    expect(t.text()).toContain('Upgrading agents');
    t.fixture.componentRef.setInput('organizationId', OTHER);
    await t.settle();
    expect(t.text()).toBe('');
    expect(t.api.agentUpgrades).toHaveBeenLastCalledWith(OTHER);
  });
});
