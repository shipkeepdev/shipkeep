import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KekError, loadKek } from './kek';

async function tempFile(name: string, content: Buffer | string, mode: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shipkeep-kek-'));
  const path = join(dir, name);
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return path;
}

describe('loadKek', () => {
  const key = randomBytes(32);

  it('loads a raw 32-byte key', async () => {
    const kek = await loadKek(await tempFile('kek', key, 0o400));
    expect(kek.expose()).toEqual(key);
    expect(String(kek)).not.toContain(key.toString('hex'));
  });

  it('loads a base64 key with a trailing newline', async () => {
    const kek = await loadKek(await tempFile('kek', `${key.toString('base64')}\n`, 0o600));
    expect(kek.expose()).toEqual(key);
  });

  it('refuses group or world readable files', async () => {
    await expect(loadKek(await tempFile('kek', key, 0o640))).rejects.toThrow(/readable by group/);
    await expect(loadKek(await tempFile('kek', key, 0o644))).rejects.toThrow(KekError);
  });

  it('refuses keys of the wrong size or encoding', async () => {
    await expect(loadKek(await tempFile('kek', randomBytes(16), 0o400))).rejects.toThrow(
      /32 raw bytes/,
    );
    await expect(loadKek(await tempFile('kek', 'not-a-key', 0o400))).rejects.toThrow(KekError);
  });

  it('refuses missing files and non-files', async () => {
    await expect(loadKek('/nonexistent/kek')).rejects.toThrow(/cannot read/);
    await expect(loadKek('/dev/null')).rejects.toThrow(/not a regular file/);
  });
});
