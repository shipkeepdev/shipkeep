import { containerName } from './container-plan';
import {
  containerOwner,
  type OwningApplication,
  ownerSuffixes,
  parseUntrackedTarget,
  type UnmatchedContainer,
  unmatchedChanged,
  untrackedContainers,
  untrackedTarget,
} from './untracked-containers';

const app = (id: string, name: string, deploying = false): OwningApplication => ({
  id,
  name,
  projectId: '0192f0c0-0000-7000-8000-0000000000c1',
  environmentId: '0192f0c0-0000-7000-8000-0000000000d1',
  deploying,
});
const web = app('0192f0c0-0000-7000-8000-00000000a1b2', 'web');
const api = app('0192f0c0-0000-7000-8000-00000000c3d4', 'api');
const observedAt = new Date('2026-11-26T12:00:00Z');
const unmatched = (
  name: string,
  state: UnmatchedContainer['state'] = 'running',
): UnmatchedContainer => ({
  name,
  containerId: 'f'.repeat(64),
  state,
  observedAt,
});

describe('containerOwner', () => {
  it('reads the application, release and replica of every name the pipeline builds', () => {
    for (const [release, index] of [
      [1, 0],
      [2, 3],
      [123456789, 99],
      [7, 'release'],
    ] as const) {
      const name = containerName(
        { id: web.id, name: 'a-long-application-name-that-is-cut' },
        release,
        index,
      );
      expect(containerOwner(name)).toEqual({
        applicationSuffix: '00000000a1b2',
        release,
        replica: index === 'release' ? 'task' : index,
      });
    }
  });

  it('reads no owner from a name the pipeline does not build', () => {
    for (const name of [
      'sk-web',
      'sk-web-00000000a1b2-r0-0',
      'sk-web-00000000a1b2-r01-0',
      'sk-web-00000000A1B2-r1-0',
      'sk-web-0000000a1b2-r1-0',
      'sk-web-00000000a1b2-r1-01',
      'sk-web-00000000a1b2-r1-',
      'sk-web-00000000a1b2-r1-0 ',
      'sk-web-00000000a1b2-r1-0\n',
      'sk-web-00000000a1b2-r1-tasks',
      'web-00000000a1b2-r1-0',
      'sk-postgres',
      'sk-env-0192f0c0000070008000000000000d1',
    ])
      expect(containerOwner(name), name).toBeUndefined();
  });
});

describe('unmatchedChanged', () => {
  const reported = (
    name: string,
    state: UnmatchedContainer['state'] = 'running',
    id = 'f'.repeat(64),
  ) => ({
    name,
    containerId: id,
    state,
    stopReason: null,
  });

  it('sees the same set as unchanged, whatever its order', () => {
    const stored = [unmatched('sk-a-00000000a1b2-r1-0'), unmatched('sk-b-00000000c3d4-r1-0')];
    expect(
      unmatchedChanged(stored, [
        reported('sk-b-00000000c3d4-r1-0'),
        reported('sk-a-00000000a1b2-r1-0'),
      ]),
    ).toBe(false);
  });

  it('sees a container added, gone, replaced or in another state', () => {
    const stored = [unmatched('sk-a-00000000a1b2-r1-0')];
    expect(unmatchedChanged(stored, [])).toBe(true);
    expect(unmatchedChanged([], [reported('sk-a-00000000a1b2-r1-0')])).toBe(true);
    expect(unmatchedChanged(stored, [reported('sk-a-00000000a1b2-r1-0', 'exited')])).toBe(true);
    expect(
      unmatchedChanged(stored, [reported('sk-a-00000000a1b2-r1-0', 'running', 'e'.repeat(64))]),
    ).toBe(true);
    expect(unmatchedChanged(stored, [reported('sk-a-00000000a1b2-r2-0')])).toBe(true);
  });
});

describe('untrackedContainers', () => {
  it('lists the containers of an application of the organization, by name', () => {
    const containers = [
      unmatched('sk-web-00000000a1b2-r3-0'),
      unmatched('sk-api-00000000c3d4-r9-task', 'exited'),
    ];
    expect(
      untrackedContainers(containers, [web, api]).map((c) => [
        c.name,
        c.application.name,
        c.release,
        c.replica,
      ]),
    ).toEqual([
      ['sk-api-00000000c3d4-r9-task', 'api', 9, 'task'],
      ['sk-web-00000000a1b2-r3-0', 'web', 3, 0],
    ]);
  });

  it('leaves out what belongs to no known application, or to one being deployed', () => {
    const containers = [
      unmatched('sk-gone-0000000000ff-r1-0'),
      unmatched('sk-postgres'),
      unmatched('sk-web-00000000a1b2-r3-0'),
    ];
    expect(untrackedContainers(containers, [app(web.id, 'web', true)])).toEqual([]);
  });

  it('claims nothing for a suffix two applications share', () => {
    const twin = app('0192f0c0-0000-7000-8001-00000000a1b2', 'twin');
    expect(untrackedContainers([unmatched('sk-web-00000000a1b2-r3-0')], [web, twin])).toEqual([]);
  });

  it('asks for the applications its containers name, once each', () => {
    expect(
      ownerSuffixes([
        unmatched('sk-web-00000000a1b2-r3-0'),
        unmatched('sk-web-00000000a1b2-r4-0'),
        unmatched('sk-postgres'),
        unmatched('sk-api-00000000c3d4-r1-0'),
      ]),
    ).toEqual(['00000000a1b2', '00000000c3d4']);
  });
});

describe('untracked container confirmation target', () => {
  it('names the node and the container, and reads back only that shape', () => {
    const node = '0192f0c0-0000-7000-8000-0000000000e1';
    expect(parseUntrackedTarget(untrackedTarget(node, 'sk-web-00000000a1b2-r3-0'))).toEqual({
      nodeId: node,
      name: 'sk-web-00000000a1b2-r3-0',
    });
    for (const target of [
      node,
      `${node}/`,
      `${node}/web`,
      `${node}/sk-web/../x`,
      `../${node}/sk-web-00000000a1b2-r3-0`,
      `${node}/sk-WEB`,
    ])
      expect(parseUntrackedTarget(target), target).toBeUndefined();
  });
});
