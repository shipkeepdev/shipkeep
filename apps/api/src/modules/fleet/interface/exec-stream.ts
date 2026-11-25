import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  type ExecStreamRequest,
  type ExecStreamResponse,
  ExecStreamResponseSchema,
} from '@shipkeep/proto-ts';

import type { AgentFrame, BrowserFrame, ExecSessionRegistry } from '../application/exec-relay';
import { NodeAuthenticationError, type NodeIdentity } from '../domain/node-identity';

/** How often an open session checks again that its node is still enrolled and not revoked. */
export const CREDENTIAL_CHECK_MS = 10_000;
/** How long an agent may take to name its session once its stream is open. */
export const EXEC_OPEN_MS = 10_000;

/**
 * The agent's side of an exec session (SPEC 3.1): its first frame names the session, within
 * EXEC_OPEN_MS, which must be one opened for this node of this organization, and joined once. The
 * node's credential is checked again before it joins. Output reaches the browser once it joined
 * too; the browser's frames reach the agent, and the last one stops the command.
 */
export async function* relayExecStream(
  registry: ExecSessionRegistry,
  requests: AsyncIterable<ExecStreamRequest>,
  node: NodeIdentity,
  stillValid: () => Promise<unknown>,
  signal?: AbortSignal,
): AsyncGenerator<ExecStreamResponse> {
  const incoming = requests[Symbol.asyncIterator]();
  const sessionId = await opened(incoming, registry, node, stillValid, signal);
  const relay = registry.joinAgent(sessionId, node);
  // Unknown, foreign, expired or already joined: the same answer, which says nothing more.
  if (!relay) throw new ConnectError('exec session not found', Code.NotFound);
  // Not awaited: it ends when the stream does, which this generator's end causes.
  void (async () => {
    try {
      if (!(await relay.bothJoined())) return;
      for (;;) {
        const next = await incoming.next();
        if (next.done) break;
        const frame = agentFrame(next.value);
        if (!frame) {
          relay.end('failed', null);
          break;
        }
        await relay.fromAgent(frame);
        if (relay.over) break;
      }
    } catch {
      // The stream broke: the session ends below.
    }
    relay.agentLeft();
  })();
  // A node removed or revoked during the session loses it, as its Connect stream ends.
  const check = setInterval(() => {
    stillValid().catch(() => {
      relay.agentLeft();
    });
  }, CREDENTIAL_CHECK_MS);
  check.unref();
  try {
    for await (const frame of relay.toAgent()) yield responseFrame(frame);
  } finally {
    clearInterval(check);
    relay.agentLeft();
  }
}

/**
 * The session the stream opens, named by its first frame and checked before it joins: the
 * session is this node's, and the node's credential still holds. All of it within EXEC_OPEN_MS
 * and while the transport lasts, so a silent or stalled stream holds nothing for long; past
 * either, the read under way is let go with the stream.
 */
async function opened(
  incoming: AsyncIterator<ExecStreamRequest>,
  registry: ExecSessionRegistry,
  node: NodeIdentity,
  stillValid: () => Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ConnectError('an exec stream names its session at once', Code.DeadlineExceeded));
    }, EXEC_OPEN_MS);
    cancelled = () => {
      reject(new ConnectError('exec stream cancelled', Code.Canceled));
    };
    if (signal?.aborted) cancelled();
    else signal?.addEventListener('abort', cancelled, { once: true });
  });
  try {
    const first = await Promise.race([incoming.next(), stopped]);
    if (first.done || first.value.frame.case !== 'open')
      throw new ConnectError('an exec stream opens a session first', Code.InvalidArgument);
    const sessionId = first.value.frame.value.sessionId;
    // Refused at once when it is not this node's: no lookup of the credential for it.
    const session = registry.pending(sessionId);
    if (session?.organizationId !== node.organizationId || session.nodeId !== node.nodeId)
      throw new ConnectError('exec session not found', Code.NotFound);
    // A node removed or revoked while its stream opened joins nothing; a store that cannot
    // tell is no refusal of the node, and the agent may open its stream again.
    await Promise.race([
      stillValid().catch((error: unknown) => {
        throw error instanceof NodeAuthenticationError
          ? new ConnectError('node authentication required', Code.Unauthenticated)
          : new ConnectError('the node could not be checked', Code.Unavailable);
      }),
      stopped,
    ]);
    if (signal?.aborted) throw new ConnectError('exec stream cancelled', Code.Canceled);
    return sessionId;
  } catch (error: unknown) {
    void incoming.return?.().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    if (cancelled) signal?.removeEventListener('abort', cancelled);
  }
}

/** The agent's output, exit or error; undefined for anything else, such as a second open. */
export function agentFrame(request: ExecStreamRequest): AgentFrame | undefined {
  const frame = request.frame;
  switch (frame.case) {
    case 'stdout':
    case 'stderr':
      return { kind: frame.case, data: frame.value };
    case 'exit':
      return { kind: 'exit', code: frame.value.exitCode };
    case 'error':
      return { kind: 'error', message: frame.value.message };
    default:
      return undefined;
  }
}

export function responseFrame(frame: BrowserFrame): ExecStreamResponse {
  switch (frame.kind) {
    case 'stdin':
      return create(ExecStreamResponseSchema, { frame: { case: 'stdin', value: frame.data } });
    case 'resize':
      return create(ExecStreamResponseSchema, {
        frame: { case: 'resize', value: { cols: frame.cols, rows: frame.rows } },
      });
    case 'close':
      return create(ExecStreamResponseSchema, {
        frame: { case: 'close', value: { kill: frame.kill } },
      });
  }
}
