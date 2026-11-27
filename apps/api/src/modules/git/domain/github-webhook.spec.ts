import { InvalidInputError } from '@shipkeep/domain';
import { describe, expect, it } from 'vitest';

import {
  changeApplies,
  deliveryHeaders,
  type InstallationChange,
  installationChange,
  pingedApp,
  WebhookRejected,
  pushOf,
} from './github-webhook';

const signature = `sha256=${'ab'.repeat(32)}`;
const delivery = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const installation = (overrides: Record<string, unknown> = {}) => ({
  action: 'created',
  installation: {
    id: 99,
    app_id: 7,
    repository_selection: 'selected',
    updated_at: '2026-11-25T10:00:00Z',
    account: { login: 'acme-corp', type: 'Organization' },
    ...overrides,
  },
  sender: { login: 'octocat' },
});
const now = new Date('2026-11-25T10:01:00Z');

describe('GitHub deliveries (ADR 0031)', () => {
  it('reads the headers GitHub sends, and refuses a delivery without a signature', () => {
    expect(deliveryHeaders({ event: 'push', delivery: delivery.toUpperCase(), signature })).toEqual(
      { event: 'push', delivery, signature: 'ab'.repeat(32) },
    );
    for (const bad of [
      undefined,
      'sha1=abc',
      `sha256=${'g'.repeat(64)}`,
      `sha256=${'a'.repeat(63)}`,
    ])
      expect(() => deliveryHeaders({ event: 'push', delivery, signature: bad })).toThrow(
        WebhookRejected,
      );
    for (const [event, id] of [
      ['Push', delivery],
      ['push; drop', delivery],
      ['push', 'not-a-guid'],
      [undefined, delivery],
    ])
      expect(() => deliveryHeaders({ event, delivery: id, signature })).toThrow(InvalidInputError);
  });

  it('reads a header given twice as missing, never as text', () => {
    const twice = [signature, signature] as unknown as string;
    expect(() => deliveryHeaders({ event: 'push', delivery, signature: twice })).toThrow(
      WebhookRejected,
    );
    const events = ['push', 'ping'] as unknown as string;
    expect(() => deliveryHeaders({ event: events, delivery, signature })).toThrow(
      InvalidInputError,
    );
  });

  it('reads an installation of this App, and refuses one of another App', () => {
    expect(installationChange('installation', installation(), 7, now)).toEqual({
      action: 'created',
      installationId: 99,
      accountLogin: 'acme-corp',
      accountType: 'Organization',
      repositorySelection: 'selected',
      updatedAt: new Date('2026-11-25T10:00:00Z'),
    });
    expect(
      installationChange(
        'installation',
        { ...installation(), action: 'new_permissions_accepted' },
        7,
        now,
      ),
    ).toBe(undefined);
    for (const payload of [
      installation({ app_id: 8 }),
      installation({ id: -1 }),
      installation({ account: { login: 'a/b', type: 'User' } }),
      installation({ account: { login: 'acme', type: 'Bot' } }),
      installation({ repository_selection: 'some' }),
      installation({ updated_at: undefined }),
      installation({ updated_at: 'yesterday' }),
      // GitHub's clock may run ahead by minutes, not by an hour.
      installation({ updated_at: '2026-11-25T11:01:00Z' }),
      null,
      [],
    ])
      expect(() => installationChange('installation', payload, 7, now)).toThrow(InvalidInputError);
  });

  it('reads a change of repository selection as a change of the installation', () => {
    const added = { ...installation({ repository_selection: 'all' }), action: 'added' };
    expect(installationChange('installation_repositories', added, 7, now)).toMatchObject({
      action: 'repositories',
      repositorySelection: 'all',
    });
    expect(
      installationChange('installation_repositories', { ...added, action: 'other' }, 7, now),
    ).toBeUndefined();
    // An installation event named like a selection change is not one.
    expect(installationChange('installation', added, 7, now)).toBeUndefined();
  });

  it('reads the App a ping names', () => {
    expect(pingedApp({ hook: { app_id: 7 } })).toBe(7);
    expect(pingedApp({ hook: { app_id: '7' } })).toBeUndefined();
    expect(pingedApp({})).toBeUndefined();
  });

  describe("the order of an installation's changes (#475, #476)", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 25, 9, minute));
    const change = (action: InstallationChange['action'], minute: number): InstallationChange => ({
      action,
      installationId: 77,
      accountLogin: 'acme-corp',
      accountType: 'Organization',
      repositorySelection: 'selected',
      updatedAt: at(minute),
    });
    const active = { updatedAt: at(10), suspendedAt: null, deletedAt: null };
    const suspended = { updatedAt: at(10), suspendedAt: at(10), deletedAt: null };
    const removed = { updatedAt: at(10), suspendedAt: null, deletedAt: at(12) };

    it('applies a first change, a newer one, never an older one', () => {
      expect(changeApplies(change('unsuspend', 5), undefined)).toBe(true);
      expect(changeApplies(change('repositories', 5), null)).toBe(true);
      expect(changeApplies(change('suspend', 11), active)).toBe(true);
      expect(changeApplies(change('unsuspend', 9), suspended)).toBe(false);
    });

    it('keeps the more restrictive state at equal times', () => {
      expect(changeApplies(change('suspend', 10), active)).toBe(true);
      for (const action of ['created', 'unsuspend', 'repositories', 'suspend'] as const)
        expect(changeApplies(change(action, 10), suspended), action).toBe(false);
      for (const action of ['created', 'unsuspend', 'repositories'] as const)
        expect(changeApplies(change(action, 10), active), action).toBe(false);
    });

    it('applies a removal whatever its time, and nothing after it', () => {
      expect(changeApplies(change('deleted', 1), active)).toBe(true);
      expect(changeApplies(change('deleted', 1), undefined)).toBe(true);
      for (const action of ['created', 'unsuspend', 'repositories', 'suspend', 'deleted'] as const)
        for (const minute of [11, 13])
          expect(changeApplies(change(action, minute), removed), action).toBe(false);
    });
  });
});

describe('a push to a branch (#213)', () => {
  const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
  const payload = (overrides: Record<string, unknown> = {}) => ({
    ref: 'refs/heads/feature/login',
    after: 'f'.repeat(40),
    repository: { id: 901 },
    installation: { id: 31 },
    sender: { login: 'octocat' },
    ...overrides,
  });

  it('reads the branch, the commit, the repository, the installation and the pusher', () => {
    expect(pushOf(ORG, payload())).toEqual({
      organizationId: ORG,
      installationId: 31,
      repositoryId: 901,
      branch: 'feature/login',
      commit: 'f'.repeat(40),
      pusher: 'octocat',
    });
    expect(pushOf(ORG, payload({ sender: { login: 'not a login' } }))?.pusher).toBeNull();
  });

  it('deploys nothing for a tag, a deleted branch, or a field GitHub could not have sent', () => {
    for (const other of [
      payload({ ref: 'refs/tags/v1.0.0' }),
      payload({ ref: 'refs/heads/a..b' }),
      payload({ ref: 'refs/heads/' }),
      payload({ deleted: true }),
      payload({ after: '0'.repeat(40) }),
      payload({ after: 'F'.repeat(40) }),
      payload({ after: 'f'.repeat(39) }),
      payload({ repository: { id: '901' } }),
      payload({ repository: { id: 0 } }),
      payload({ installation: undefined }),
      payload({ installation: { id: 2 ** 60 } }),
      null,
      [],
    ])
      expect(pushOf(ORG, other), JSON.stringify(other)).toBeUndefined();
  });
});
