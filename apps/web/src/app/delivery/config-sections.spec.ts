import { DEFAULT_RESOURCES } from '@shipkeep/config-schema';

import { FR } from '../ui/fr';

import {
  certificateState,
  configSection,
  DEFAULT_LIMIT_TEXT,
  RENEWAL_LATE_DAYS,
  type SectionData,
} from './config-sections';
import { type DomainStatus } from './delivery-api';

const data = (resources?: { cpu?: string; memory?: string; disk?: string }): SectionData => ({
  config: { version: 1, name: 'api', ...(resources ? { resources } : {}) },
  configSha: 'a'.repeat(64),
  release: undefined,
  secrets: [],
  domains: [],
  replicas: [],
  now: new Date('2026-11-20T12:00:00Z'),
});
const limits = (resources?: { cpu?: string; memory?: string; disk?: string }) => {
  const block = configSection('limits', data(resources))?.blocks[0];
  return block?.type === 'fields' ? block.items.map((item) => [item.l, item.v]) : [];
};

describe('resource limits section', () => {
  it('shows the default limits of an application that declares none, never "no limit"', () => {
    expect(limits()).toEqual([
      ['CPU', '1 CPU (default)'],
      ['Memory', '512Mi (default)'],
      ['Disk', '1Gi (default)'],
      ['Read-only root', 'off'],
      ['Replicas', '1'],
    ]);
  });

  it('shows a declared limit as written, and the default for the one left out', () => {
    expect(limits({ cpu: '250m', disk: '4Gi' })).toEqual([
      ['CPU', '250m'],
      ['Memory', '512Mi (default)'],
      ['Disk', '4Gi'],
      ['Read-only root', 'off'],
      ['Replicas', '1'],
    ]);
  });

  it('states the defaults the control plane applies, in both languages', () => {
    expect(DEFAULT_LIMIT_TEXT).toEqual({
      cpu: `${DEFAULT_RESOURCES.cpu} CPU (default)`,
      memory: `${DEFAULT_RESOURCES.memory} (default)`,
      disk: `${DEFAULT_RESOURCES.disk} (default)`,
    });
    expect(FR[DEFAULT_LIMIT_TEXT.disk]).toBe('1Gi (par défaut)');
    expect(FR[DEFAULT_LIMIT_TEXT.cpu]).toBe('1 CPU (par défaut)');
    expect(FR[DEFAULT_LIMIT_TEXT.memory]).toBe('512Mi (par défaut)');
  });
});

describe('instances section', () => {
  it('says when the agent stopped a replica for its disk budget (ADR 0022)', () => {
    const block = configSection('placement', {
      ...data(),
      replicas: [
        {
          id: 'r1',
          releaseId: 'rel',
          replica: 0,
          nodeId: 'n1',
          nodeName: 'edge-1',
          container: 'sk-api-0',
          state: 'exited',
          stopReason: 'disk_limit',
          observedAt: '2026-11-19T12:00:00.000Z',
        },
      ],
    })?.blocks.find((candidate) => candidate.type === 'table');
    const cells = block?.type === 'table' ? block.rows[0] : [];
    expect(JSON.stringify(cells)).toContain('stopped: disk limit');
    expect(FR['stopped: disk limit']).toBe('arrêté : limite disque');
  });

  it('shows the state of a running replica, whatever reason comes with it', () => {
    const block = configSection('placement', {
      ...data(),
      replicas: [
        {
          id: 'r1',
          releaseId: 'rel',
          replica: 0,
          nodeId: 'n1',
          nodeName: 'edge-1',
          container: 'sk-api-0',
          state: 'running',
          stopReason: 'disk_limit',
          observedAt: '2026-11-19T12:00:00.000Z',
        },
      ],
    })?.blocks.find((candidate) => candidate.type === 'table');
    const cells = JSON.stringify(block?.type === 'table' ? block.rows[0] : []);
    expect(cells).toContain('running');
    expect(cells).not.toContain('disk limit');
  });
});

describe('certificate column', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const domain = (notAfter: string | null): DomainStatus => ({
    hostname: 'shop.example.com',
    status: 'public',
    addresses: ['203.0.113.10'],
    match: 'serving',
    certificate: notAfter ? { notAfter, issuer: 'R11', observedAt: '2026-11-20T11:59:00Z' } : null,
  });
  const at = (days: number) =>
    new Date(now.getTime() + days * 86_400_000 + 3_600_000).toISOString();
  const cell = (notAfter: string | null) => {
    const value = certificateState(domain(notAfter), now);
    return typeof value === 'string' ? { t: value } : value;
  };

  it('says when no server reported a certificate for the name recently', () => {
    expect(cell(null).t).toBe('no recent reading');
  });

  it('counts the days left, with the colour of how late renewal is', () => {
    expect(cell(at(60))).toEqual(
      expect.objectContaining({ t: '{n} days left', values: { n: 60 } }),
    );
    const late = cell(at(RENEWAL_LATE_DAYS - 1));
    expect(late).toEqual(
      expect.objectContaining({ t: 'renewal late, {n} days left', values: { n: 20 } }),
    );
    expect(late.fg).not.toBe(cell(at(60)).fg);
    expect(cell(at(3))).toEqual(
      expect.objectContaining({ t: 'expires in {n} days', values: { n: 3 } }),
    );
    expect(cell(at(1)).t).toBe('expires tomorrow');
    expect(cell(at(0)).t).toBe('expires today');
    expect(cell(new Date(now.getTime() - 60_000).toISOString()).t).toBe('expired');
  });

  it('shows the column in the domains section, translated', () => {
    const section = configSection('domains', { ...data(), domains: [domain(at(60))] });
    const table = section?.blocks[0];
    expect(table?.type === 'table' ? table.heads : []).toContain('Certificate');
    for (const text of [
      'Certificate',
      'no recent reading',
      '{n} days left',
      'renewal late, {n} days left',
      'expires in {n} days',
      'expires tomorrow',
      'expires today',
      'expired',
    ])
      expect(FR[text]).toBeDefined();
  });
});
