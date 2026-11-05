import { ConflictError, type DomainEvent, Secret } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { JoinTokenRejectedError } from '../domain/join-token';

import { EnrollNode } from './enroll-node';
import {
  FAKE_CSR,
  FakeCertificateAuthority,
  FakeConfirmationKeys,
  MemoryJoinTokenStore,
  MemoryNodeStore,
} from './fakes.spec-helpers';
import { IssueJoinToken } from './issue-join-token';

const org = '0192f0c0-0000-7000-8000-0000000000aa';
const actor = { kind: 'user' as const, id: 'usr_1', ip: '203.0.113.5' };

function setup() {
  const bus = new DomainEventBus();
  const published: DomainEvent[] = [];
  bus.subscribe((e) => {
    published.push(e);
    return Promise.resolve();
  });
  const tokens = new MemoryJoinTokenStore();
  const nodes = new MemoryNodeStore();
  const ca = new FakeCertificateAuthority();
  const issue = new IssueJoinToken(tokens, ca, bus, { run: (work) => work() });
  const enroll = new EnrollNode(tokens, nodes, ca, new FakeConfirmationKeys(), bus, {
    run: (work) => work(),
  });
  return { bus, published, tokens, nodes, ca, issue, enroll };
}

describe('IssueJoinToken', () => {
  it('stores only the hash, returns the value once and audits the issuance', async () => {
    const { tokens, issue, published } = setup();
    const now = new Date('2026-11-03T12:00:00Z');
    const result = await issue.execute({ organizationId: org, actor }, now);

    expect(result.value.expose()).toHaveLength(43);
    expect(result.expiresAt.getTime()).toBe(now.getTime() + 15 * 60_000);
    expect(result.caFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const stored = tokens.records.get(result.id);
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...tokens.records.values()])).not.toContain(result.value.expose());
    expect(published.map((e) => e.type)).toEqual(['fleet.join_token.issued']);
    expect(published[0]?.target).toEqual({ type: 'join_token', id: result.id });
    expect(JSON.stringify(published)).not.toContain(result.value.expose());
  });
});

describe('EnrollNode', () => {
  it('enrolls a node with a fresh token and consumes it', async () => {
    const { issue, enroll, nodes, tokens, ca, published } = setup();
    const token = await issue.execute({ organizationId: org, actor });

    const result = await enroll.execute({
      joinToken: token.value,
      csrPem: FAKE_CSR,
      facts: { hostname: 'Edge-1.example.com', cpu_count: 4, bogus: { nested: true } },
      agentVersion: '0.1.0',
      ip: '198.51.100.7',
    });

    expect(result.organizationId).toBe(org);
    expect(result.leaseEpoch).toBe(1);
    expect(result.certificatePem).toContain('NODE1');
    expect(result.caPem).toContain('FAKECA');
    expect(result.confirmationPublicKeyPem).toContain('PUBLIC KEY');
    expect(nodes.nodes).toHaveLength(1);
    expect(nodes.nodes[0]).toMatchObject({
      id: result.nodeId,
      organizationId: org,
      name: 'edge-1',
      status: 'enrolling',
      facts: { hostname: 'Edge-1.example.com', cpu_count: 4, agent_version: '0.1.0' },
    });
    expect(nodes.certificates[0]).toMatchObject({
      nodeId: result.nodeId,
      serial: '0001',
      revokedAt: null,
    });
    expect(ca.issued[0]).toEqual({ csrPem: FAKE_CSR, organizationId: org, nodeId: result.nodeId });
    expect(tokens.records.get(token.id)).toMatchObject({ usedByNodeId: result.nodeId });
    expect(tokens.records.get(token.id)?.usedAt).not.toBeNull();
    expect(published.map((e) => e.type)).toEqual([
      'fleet.join_token.issued',
      'fleet.node.enrolled',
    ]);
    expect(published[1]?.actor).toEqual({ kind: 'node', id: result.nodeId, ip: '198.51.100.7' });
  });

  it('rejects a reused token with the same message as an unknown one', async () => {
    const { issue, enroll } = setup();
    const token = await issue.execute({ organizationId: org, actor });
    await enroll.execute({
      joinToken: token.value,
      csrPem: FAKE_CSR,
      facts: { hostname: 'a-1' },
      agentVersion: '0.1.0',
    });

    const reuse = enroll.execute({
      joinToken: token.value,
      csrPem: FAKE_CSR,
      facts: { hostname: 'a-2' },
      agentVersion: '0.1.0',
    });
    await expect(reuse).rejects.toThrow(JoinTokenRejectedError);
    await expect(reuse).rejects.toThrow('join token is invalid, expired or already used');
    const unknown = enroll.execute({
      joinToken: new Secret('x'.repeat(43)),
      csrPem: FAKE_CSR,
      facts: {},
      agentVersion: '0.1.0',
    });
    await expect(unknown).rejects.toThrow('join token is invalid, expired or already used');
  });

  it('rejects expired and malformed tokens', async () => {
    const { issue, enroll } = setup();
    const issuedAt = new Date('2026-11-03T12:00:00Z');
    const token = await issue.execute({ organizationId: org, actor }, issuedAt);
    const late = new Date(issuedAt.getTime() + 15 * 60_000 + 1);
    await expect(
      enroll.execute(
        { joinToken: token.value, csrPem: FAKE_CSR, facts: {}, agentVersion: '0.1.0' },
        late,
      ),
    ).rejects.toMatchObject({ reason: 'expired' });
    await expect(
      enroll.execute({
        joinToken: new Secret('not a token'),
        csrPem: FAKE_CSR,
        facts: {},
        agentVersion: '0.1.0',
      }),
    ).rejects.toMatchObject({ reason: 'malformed' });
  });

  it('rejects duplicate node names and oversized CSRs without touching the token', async () => {
    const { issue, enroll, tokens } = setup();
    const first = await issue.execute({ organizationId: org, actor });
    await enroll.execute({
      joinToken: first.value,
      csrPem: FAKE_CSR,
      facts: {},
      agentVersion: '0.1.0',
      name: 'edge-1',
    });

    const second = await issue.execute({ organizationId: org, actor });
    await expect(
      enroll.execute({
        joinToken: second.value,
        csrPem: FAKE_CSR,
        facts: {},
        agentVersion: '0.1.0',
        name: 'edge-1',
      }),
    ).rejects.toThrow(ConflictError);
    await expect(
      enroll.execute({
        joinToken: second.value,
        csrPem: 'x'.repeat(10_000),
        facts: {},
        agentVersion: '0.1.0',
      }),
    ).rejects.toMatchObject({ kind: 'invalid', code: 'csr_too_large' });
    expect(tokens.records.get(second.id)?.usedAt).toBeNull();
  });

  it('falls back to a generated name when the hostname is unusable', async () => {
    const { issue, enroll } = setup();
    const token = await issue.execute({ organizationId: org, actor });
    const result = await enroll.execute({
      joinToken: token.value,
      csrPem: FAKE_CSR,
      facts: { hostname: '___' },
      agentVersion: '0.1.0',
    });
    expect(result.nodeId).toBeDefined();
  });
});
