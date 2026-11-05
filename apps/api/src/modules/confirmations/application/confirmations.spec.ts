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

function setup(options: { allowed?: boolean; name?: string | null } = {}) {
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
  const accounts = {
    run: <T>(_context: unknown, operation: () => Promise<T>) => operation(),
  } as unknown as AccountMutationAuthority;
  const access = {
    require: () =>
      options.allowed === false ? Promise.reject(new NotFoundError('resource')) : Promise.resolve(),
  } as unknown as TenantAccess;
  const inline = { runTenant: <T>(_org: string, work: () => Promise<T>) => work() };
  const commands = new ConfirmationCommands(store, inline, keys, targets, accounts, access, bus);
  const verifier = new ConfirmationVerifier(store, keys);
  return { commands, verifier, store, events };
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
});
