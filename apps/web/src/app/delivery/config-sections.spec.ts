import { DEFAULT_RESOURCES } from '@shipkeep/config-schema';

import { FR } from '../ui/fr';

import { configSection, DEFAULT_LIMIT_TEXT, type SectionData } from './config-sections';

const data = (resources?: { cpu?: string; memory?: string }): SectionData => ({
  config: { version: 1, name: 'api', ...(resources ? { resources } : {}) },
  configSha: 'a'.repeat(64),
  release: undefined,
  secrets: [],
  domains: [],
  replicas: [],
});
const limits = (resources?: { cpu?: string; memory?: string }) => {
  const block = configSection('limits', data(resources))?.blocks[0];
  return block?.type === 'fields' ? block.items.map((item) => [item.l, item.v]) : [];
};

describe('resource limits section', () => {
  it('shows the default limits of an application that declares none, never "no limit"', () => {
    expect(limits()).toEqual([
      ['CPU', '1 CPU (default)'],
      ['Memory', '512Mi (default)'],
      ['Replicas', '1'],
    ]);
  });

  it('shows a declared limit as written, and the default for the one left out', () => {
    expect(limits({ cpu: '250m' })).toEqual([
      ['CPU', '250m'],
      ['Memory', '512Mi (default)'],
      ['Replicas', '1'],
    ]);
  });

  it('states the defaults the control plane applies, in both languages', () => {
    expect(DEFAULT_LIMIT_TEXT).toEqual({
      cpu: `${DEFAULT_RESOURCES.cpu} CPU (default)`,
      memory: `${DEFAULT_RESOURCES.memory} (default)`,
    });
    expect(FR[DEFAULT_LIMIT_TEXT.cpu]).toBe('1 CPU (par défaut)');
    expect(FR[DEFAULT_LIMIT_TEXT.memory]).toBe('512Mi (par défaut)');
  });
});
