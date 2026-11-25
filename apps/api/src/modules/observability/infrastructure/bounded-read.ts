/**
 * The body of a store's answer, read up to `max` bytes. Any failure, a body past `max` included,
 * becomes `fail()`: the caller learns that the store was unavailable, never why.
 */
export async function readBounded(
  response: Response,
  max: number,
  fail: () => Error,
): Promise<string> {
  // Node's fetch types its body loosely: it is a stream of bytes.
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) break;
      chunks.push(value);
    }
  } catch {
    throw fail();
  }
  if (size > max) {
    await reader.cancel().catch(() => undefined);
    throw fail();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Lets go of an answer whose body is not read; a body that breaks meanwhile changes nothing. */
export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
