import { DEFAULT_RESOURCES } from '@shipkeep/config-schema';

import { FR } from '../ui/fr';

import { configSection, DEFAULT_LIMIT_TEXT, type SectionData } from './config-sections';

const data = (resources?: { cpu?: string; memory?: string; disk?: string }): SectionData => ({
  config: { version: 1, name: 'api', ...(resources ? { resources } : {}) },
  configSha: 'a'.repeat(64),
  release: undefined,
  secrets: [],
  domains: [],
  replicas: [],
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
