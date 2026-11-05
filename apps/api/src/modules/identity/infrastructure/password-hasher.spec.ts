import { Secret } from '@shipkeep/domain';
import { hash } from 'argon2';

import { PasswordHasher } from './password-hasher';

vi.mock('argon2', () => ({ argon2id: 2, hash: vi.fn(), verify: vi.fn() }));

describe('password hashing capacity', () => {
  it('bounds active work and queued requests and releases capacity after failure', async () => {
    const pending: { resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
    vi.mocked(hash).mockImplementation(
      () =>
        new Promise<string>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    const hasher = new PasswordHasher();
    const password = new Secret('a sufficiently long password');
    const tasks = Array.from({ length: 18 }, () =>
      hasher.hash(password).catch((error: unknown) => error),
    );
    expect(pending).toHaveLength(2);
    await expect(hasher.hash(password)).rejects.toThrow('Authentication temporarily unavailable.');
    pending.shift()?.reject(new Error('unsafe native-library detail'));
    await vi.waitFor(() => {
      expect(vi.mocked(hash)).toHaveBeenCalledTimes(3);
    });
    expect(pending).toHaveLength(2);
    for (let completed = 0; completed < 17; completed++) {
      await vi.waitFor(() => {
        expect(pending.length).toBeGreaterThan(0);
      });
      pending.shift()?.resolve('test digest');
    }
    const results = await Promise.all(tasks);
    expect(String(results[0])).not.toContain('unsafe');
    expect(results.slice(1).every((result) => result instanceof Secret)).toBe(true);
    vi.mocked(hash).mockResolvedValue('test digest');
    await expect(hasher.hash(password)).resolves.toBeInstanceOf(Secret);
  });
});
