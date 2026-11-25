import { InvalidInputError } from '@shipkeep/domain';
import { describe, expect, it } from 'vitest';

import { deliveryHeaders, installationChange, pingedApp, WebhookRejected } from './github-webhook';

const signature = `sha256=${'ab'.repeat(32)}`;
const delivery = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const installation = (overrides: Record<string, unknown> = {}) => ({
  action: 'created',
  installation: {
    id: 99,
    app_id: 7,
    repository_selection: 'selected',
    account: { login: 'acme-corp', type: 'Organization' },
    ...overrides,
  },
  sender: { login: 'octocat' },
});

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

  it('reads an installation of this App, and refuses one of another App', () => {
    expect(installationChange(installation(), 7)).toEqual({
      action: 'created',
      installationId: 99,
      accountLogin: 'acme-corp',
      accountType: 'Organization',
      repositorySelection: 'selected',
    });
    expect(installationChange({ ...installation(), action: 'new_permissions_accepted' }, 7)).toBe(
      undefined,
    );
    for (const payload of [
      installation({ app_id: 8 }),
      installation({ id: -1 }),
      installation({ account: { login: 'a/b', type: 'User' } }),
      installation({ account: { login: 'acme', type: 'Bot' } }),
      installation({ repository_selection: 'some' }),
      null,
      [],
    ])
      expect(() => installationChange(payload, 7)).toThrow(InvalidInputError);
  });

  it('reads the App a ping names', () => {
    expect(pingedApp({ hook: { app_id: 7 } })).toBe(7);
    expect(pingedApp({ hook: { app_id: '7' } })).toBeUndefined();
    expect(pingedApp({})).toBeUndefined();
  });
});
