import { describe, expect, it } from 'vitest';

import { discard, readBounded } from './bounded-read';

class Unavailable extends Error {}
const fail = () => new Unavailable();

function body(...parts: (string | Error)[]): Response {
  const encoder = new TextEncoder();
  let next = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next >= parts.length) {
          controller.close();
          return;
        }
        const part = parts[next++];
        if (part instanceof Error) controller.error(part);
        else controller.enqueue(encoder.encode(part));
      },
    }),
  );
}

describe('reading a store answer', () => {
  it('reads a body within its bound', async () => {
    expect(await readBounded(body('ab', 'cd'), 4, fail)).toBe('abcd');
    expect(await readBounded(new Response(null), 4, fail)).toBe('');
  });

  it('fails as the store is unavailable past the bound, or when the body breaks', async () => {
    await expect(readBounded(body('ab', 'cde'), 4, fail)).rejects.toBeInstanceOf(Unavailable);
    await expect(readBounded(body('ab', new TypeError('reset')), 4, fail)).rejects.toBeInstanceOf(
      Unavailable,
    );
  });

  it('discards a body without failing', async () => {
    await expect(discard(body('ab', new TypeError('reset')))).resolves.toBeUndefined();
    await expect(discard(new Response(null))).resolves.toBeUndefined();
  });
});
