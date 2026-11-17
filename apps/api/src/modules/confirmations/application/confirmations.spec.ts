import { generateKeyPairSync, sign, verify } from 'node:crypto';

import { type DomainEvent, NotFoundError, Secret } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import type { ConfirmationKeyProvider } from '../../fleet/application/ports';
import type { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { TenantAccess } from '../../organizations/application/tenant-access';
import type { ConfirmationRequest } from '../domain/confirmation-token';

import { ConfirmationCommands } from './confirmation-commands';
import { ConfirmationTargets } from './confirmation-targets';
import { ConfirmationVerifier } from './confirmation-verifier';
import type { ConfirmationRecord, ConfirmationStore } from './ports';

const org = '019d0000-0000-7000-8000-00000000000a';
const node = '019d0000-0000-7000-8000-00000000000b';
const user = '019d0000-0000-7000-8000-00000000000c';
const other = '019d0000-0000-7000-8000-00000000000d';
const application = '019d0000-0000-7000-8000-00000000000e';
const project = '019d0000-0000-7000-8000-00000000000f';
const environment = '019d0000-0000-7000-8000-000000000010';
const now = new Date('2026-11-05T12:00:00Z');
const context = { userId: user, securityVersion: 0, ip: '203.0.113.9', userAgent: 'spec' };
const request: ConfirmationRequest = { organizationId: org, action: 'node.remove', target: node };

class MemoryStore implements ConfirmationStore {
  readonly records = new Map<string, ConfirmationRecord>();
  insert(record: ConfirmationRecord): Promise<void> {
    this.records.set(record.id, record);
    return Promise.resolve();
  }
  consume(id: string, wanted: ConfirmationRequest, userId: string, at: Date): Promise<boolean> {
    const record = this.records.get(id);
    const action: string | undefined = record?.action;
    if (
      !record ||
      record.usedAt ||
      record.expiresAt <= at ||
      record.userId !== userId ||
      record.organizationId !== wanted.organizationId ||
      action !== wanted.action ||
      record.target !== wanted.target
    )
      return Promise.resolve(false);
    this.records.set(id, { ...record, usedAt: at });
    return Promise.resolve(true);
  }
}

function setup(
  options: {
    allowed?: boolean;
    name?: string | null;
    /** Where the application's resolver says it lives; null when it does not say. */
    located?: { projectId: string; environmentId: string } | null;
  } = {},
) {
  const pair = generateKeyPairSync('ed25519');
  const keys: ConfirmationKeyProvider = {
    publicKeyPem: () =>
      Promise.resolve(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    signConfirmation: (input) => Promise.resolve(sign(null, input, pair.privateKey)),
    verifyConfirmation: (input, signature) =>
      Promise.resolve(verify(null, input, pair.publicKey, signature)),
  };
  const store = new MemoryStore();
  const bus = new DomainEventBus();
  const events: DomainEvent[] = [];
  bus.subscribe((event) => {
    events.push(event);
    return Promise.resolve();
  });
  const targets = new ConfirmationTargets();
  targets.register('node.remove', {
    resolve: (wanted) =>
      Promise.resolve(
        wanted.target === node && options.name !== null ? { name: options.name ?? 'edge-1' } : null,
      ),
  });
  targets.register('application.delete', {
    resolve: (wanted) =>
      Promise.resolve(
        wanted.target === application
          ? {
              name: 'billing-api',
              ...(options.located === null
                ? {}
                : {
                    environment: options.located ?? {
                      projectId: project,
                      environmentId: environment,
                    },
                  }),
            }
          : null,
      ),
  });
  /** Every permission check and API token check, with the scope it was made on. */
  const asked: unknown[] = [];
  const accounts = {
    run: <T>(_context: unknown, operation: () => Promise<T>, authority: unknown) => {
      asked.push(['token', authority]);
      return operation();
    },
  } as unknown as AccountMutationAuthority;
  const access = {
    require: (_user: string, permission: string, scope: unknown) => {
      asked.push(['member', { permission, target: scope }]);
      return options.allowed === false
        ? Promise.reject(new NotFoundError('resource'))
        : Promise.resolve();
    },
  } as unknown as TenantAccess;
  const inline = { runTenant: <T>(_org: string, work: () => Promise<T>) => work() };
  const commands = new ConfirmationCommands(store, inline, keys, targets, accounts, access, bus);
  const verifier = new ConfirmationVerifier(store, keys);
  return { commands, verifier, store, events, asked };
}
const typed = (typedName: string) => ({ ...request, typedName });

describe('confirmation tokens end to end', () => {
  it('issues a signed token once the exact name is typed, and accepts it exactly once', async () => {
    const { commands, verifier, store, events } = setup();
    const issued = await commands.issue(context, typed('edge-1'), now);
    expect(issued.expiresAt).toEqual(new Date(now.getTime() + 300_000));
    expect(store.records.get(issued.id)).toMatchObject({ userId: user, usedAt: null });
    expect(events.map((event) => [event.type, event.organizationId, event.target.id])).toEqual([
      ['confirmation.issued', org, issued.id],
    ]);
    expect(JSON.stringify(events)).not.toContain(issued.token.expose());

    await expect(verifier.consume(issued.token, request, user, now)).resolves.toBe(issued.id);
    await expect(verifier.consume(issued.token, request, user, now)).rejects.toMatchObject({
      code: 'confirmation_rejected',
    });
  });

  it('refuses wrong names, unknown targets, actions and missing permission', async () => {
    for (const name of ['edge-2', 'EDGE-1', ' edge-1', ''])
      await expect(setup().commands.issue(context, typed(name), now)).rejects.toMatchObject({
        code: 'confirmation_name_mismatch',
      });
    await expect(
      setup({ name: null }).commands.issue(context, typed('edge-1'), now),
    ).rejects.toMatchObject({ kind: 'not_found' });
    await expect(
      setup().commands.issue(context, { ...typed('edge-1'), action: 'organization.delete' }, now),
    ).rejects.toMatchObject({ code: 'unknown_confirmation_action' });
    await expect(
      setup({ allowed: false }).commands.issue(context, typed('edge-1'), now),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('rejects forged, foreign, expired and mismatched tokens without spending them', async () => {
    const { commands, verifier, store } = setup();
    const issued = await commands.issue(context, typed('edge-1'), now);
    const [header = '', payload = '', signature = ''] = issued.token.expose().split('.');
    const flipped = `${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BA' : 'AA'}`;
    const foreign = await setup().commands.issue(context, typed('edge-1'), now);
    for (const [token, wanted, requester, at] of [
      [new Secret(`${header}.${payload}.${flipped}`), request, user, now],
      [foreign.token, request, user, now],
      [issued.token, { ...request, target: other }, user, now],
      [issued.token, { ...request, organizationId: other }, user, now],
      [issued.token, request, other, now],
      [issued.token, request, user, new Date(now.getTime() + 300_000)],
      [new Secret('not a token'), request, user, now],
    ] as const)
      await expect(verifier.consume(token, wanted, requester, at)).rejects.toMatchObject({
        code: 'confirmation_rejected',
      });
    expect(store.records.get(issued.id)?.usedAt).toBeNull();
    await expect(verifier.consume(issued.token, request, user, now)).resolves.toBe(issued.id);
  });

  describe('an action checked on an environment (application.delete)', () => {
    const wanted = {
      organizationId: org,
      action: 'application.delete',
      target: application,
      typedName: 'billing-api',
    };
    const scope = { organizationId: org, projectId: project, environmentId: environment };

    it('asks for the permission where the application lives, for members and API tokens', async () => {
      const { commands, verifier, asked } = setup();
      const issued = await commands.issue(context, wanted, now);
      const authority = { permission: 'environment.update', target: scope };
      expect(asked).toEqual([
        ['token', authority],
        ['member', authority],
      ]);
      await expect(
        verifier.consume(
          issued.token,
          { organizationId: org, action: 'application.delete', target: application },
          user,
          now,
        ),
      ).resolves.toBe(issued.id);
      // The token names its action: it cannot remove a server with the same id.
      const other = await commands.issue(context, wanted, now);
      await expect(
        verifier.consume(
          other.token,
          { organizationId: org, action: 'node.remove', target: application },
          user,
          now,
        ),
      ).rejects.toMatchObject({ code: 'confirmation_rejected' });
    });

    it('answers a missing resource for an unknown, unplaced or forbidden application', async () => {
      const unknown = setup();
      await expect(
        unknown.commands.issue(context, { ...wanted, target: other }, now),
      ).rejects.toMatchObject({ kind: 'not_found' });
      // No permission is asked on a scope that could not be read.
      expect(unknown.asked).toEqual([]);
      // A resolver that does not say where the resource lives fails closed.
      const unplaced = setup({ located: null });
      await expect(unplaced.commands.issue(context, wanted, now)).rejects.toMatchObject({
        kind: 'not_found',
      });
      expect(unplaced.asked).toEqual([]);
      await expect(
        setup({ allowed: false }).commands.issue(context, wanted, now),
      ).rejects.toMatchObject({ kind: 'not_found' });
      await expect(
        setup().commands.issue(context, { ...wanted, typedName: 'billing' }, now),
      ).rejects.toMatchObject({ code: 'confirmation_name_mismatch' });
    });

    it('keeps an organization action on the organization alone', async () => {
      const { commands, asked } = setup();
      await commands.issue(context, typed('edge-1'), now);
      const authority = { permission: 'node.manage', target: { organizationId: org } };
      expect(asked).toEqual([
        ['token', authority],
        ['member', authority],
      ]);
    });
  });
});
