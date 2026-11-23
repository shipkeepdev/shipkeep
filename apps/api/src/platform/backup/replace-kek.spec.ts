import type * as Fs from 'node:fs/promises';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { replaceKek } from './instance-backup';

// Each step of replacing the key-encryption key fails in turn: the key file must still hold one
// whole key, the one before or the restored one, and no copy of the restored key may be left.
const failures = vi.hoisted(() => ({ link: false, rename: false, directorySync: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  const injected = () => Object.assign(new Error('injected failure'), { code: 'EIO' });
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (failures.link) throw injected();
      return actual.link(...args);
    },
    // Only the rename that puts the restored key in place fails: any other one still happens.
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (failures.rename && String(args[0]).endsWith('.restoring')) throw injected();
      return actual.rename(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      // replaceKek opens the directory read-only to sync the rename.
      if (!failures.directorySync || args[1] !== 'r') return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'sync') return () => Promise.reject(injected());
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function'
            ? (value as (this: unknown, ...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    },
  };
});

const NOW = new Date('2026-11-23T10:00:00Z');
const before = Buffer.alloc(32, 9);
const restored = new Uint8Array(32).map((_, index) => index + 1);

async function installation(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'kek-'));
  const path = join(directory, 'kek');
  await writeFile(path, before, { mode: 0o400 });
  return { directory, path };
}

describe('replacing the key-encryption key when a step fails', () => {
  afterEach(() => {
    failures.link = false;
    failures.rename = false;
    failures.directorySync = false;
  });

  it('keeps the key it replaces when the second name cannot be made', async () => {
    const { directory, path } = await installation();
    failures.link = true;
    await expect(replaceKek(path, restored, NOW)).rejects.toThrow('injected failure');
    expect(await readFile(path)).toEqual(before);
    expect(await readdir(directory)).toEqual(['kek']);
  });

  it('keeps the key it replaces when the restored one cannot take its place', async () => {
    const { directory, path } = await installation();
    failures.rename = true;
    await expect(replaceKek(path, restored, NOW)).rejects.toThrow('injected failure');
    expect(await readFile(path)).toEqual(before);
    // The second name of the previous key may stay; the restored key is not left beside it.
    expect((await readdir(directory)).filter((name) => name.endsWith('.restoring'))).toEqual([]);
  });

  it('has the restored key in place when only the directory sync fails', async () => {
    const { directory, path } = await installation();
    failures.directorySync = true;
    await expect(replaceKek(path, restored, NOW)).rejects.toThrow('injected failure');
    expect(new Uint8Array(await readFile(path))).toEqual(restored);
    expect(await readFile(join(directory, 'kek.before-restore-20261123100000'))).toEqual(before);
  });
});
