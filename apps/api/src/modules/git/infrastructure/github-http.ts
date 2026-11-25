import { ServiceUnavailableException } from '@nestjs/common';

/** A GitHub answer's body, read up to `max` bytes; any failure, or more, is GitHub unavailable. */
export async function readGithubAnswer(response: Response, max: number): Promise<string> {
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
    throw githubUnavailable();
  }
  if (size > max) {
    await reader.cancel().catch(() => undefined);
    throw githubUnavailable();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Lets go of an answer whose body is not read. */
export async function discardGithubAnswer(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** GitHub's text and status stay private: the caller learns that it could not be reached. */
export function githubUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException('GitHub could not be reached. Try again in a moment.');
}
