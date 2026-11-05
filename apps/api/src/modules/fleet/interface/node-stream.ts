import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import { Injectable } from '@nestjs/common';
import {
  ConnectResponseSchema,
  type ConnectRequest,
  type ConnectResponse,
} from '@shipkeep/proto-ts';

import { AgentActions } from '../application/agent-actions';
import { AuthenticateNode } from '../application/authenticate-node';
import { NodeAuthenticationError, type NodeIdentity } from '../domain/node-identity';

const pollMs = 1000;
const idleMs = 15_000;
const tick = Symbol('tick');

/**
 * Agent stream: identity, heartbeats and at-least-once action delivery (M1.4a2). Durable leases
 * and state reports belong to M4.5 and M1.6.
 */
@Injectable()
export class NodeStream {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly authenticate: AuthenticateNode,
    private readonly actions: AgentActions,
  ) {}

  async *connect(
    input: AsyncIterable<ConnectRequest>,
    context: { readonly signal: AbortSignal },
    identity: NodeIdentity,
  ): AsyncGenerator<ConnectResponse> {
    const key = `${identity.organizationId}/${identity.nodeId}`;
    const controller = new AbortController();
    this.active.get(key)?.abort(new ConnectError('stream replaced', Code.Aborted));
    this.active.set(key, controller);
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const reader = input[Symbol.asyncIterator]();
    let pending = nextFrame(reader);
    let lastMessage = Date.now();
    let hello = false;
    // Actions sent on this stream; a new stream redelivers every unfinished one.
    const sent = new Set<string>();
    try {
      while (!signal.aborted) {
        // Poll even a silent peer: revocation, expiry and removal must terminate existing streams.
        const credential = await this.authenticate.execute(identity);
        if (hello)
          for (const request of await this.actions.deliverable(identity, sent)) {
            sent.add(request.actionId);
            yield create(ConnectResponseSchema, { msg: { case: 'actionRequest', value: request } });
          }
        const result = await waitForFrame(pending, signal);
        if (result === tick) {
          if (Date.now() - lastMessage >= idleMs)
            throw new ConnectError('agent stream idle timeout', Code.DeadlineExceeded);
          continue;
        }
        if (result.done) return;
        lastMessage = Date.now();
        const message = result.value.msg;
        if (!hello) {
          if (
            message.case !== 'hello' ||
            message.value.nodeId !== identity.nodeId ||
            message.value.leaseEpoch !== BigInt(credential.leaseEpoch) ||
            message.value.agentVersion.length > 128 ||
            message.value.inFlightActionIds.length > 1024
          )
            throw new ConnectError('invalid agent hello or stale epoch', Code.FailedPrecondition);
          hello = true;
          yield create(ConnectResponseSchema, {
            msg: {
              case: 'welcome',
              value: {
                nodeId: identity.nodeId,
                leaseEpoch: BigInt(credential.leaseEpoch),
                heartbeatInterval: { seconds: 5n },
                serverTime: timestampFromDate(new Date()),
              },
            },
          });
        } else if (message.case === 'actionUpdate') {
          await this.actions.record(identity, message.value);
        } else if (
          message.case !== 'heartbeat' ||
          message.value.leaseEpoch !== BigInt(credential.leaseEpoch) ||
          !message.value.sentAt
        ) {
          throw new ConnectError(
            'expected a heartbeat with the current epoch',
            Code.InvalidArgument,
          );
        }
        pending = nextFrame(reader);
      }
      throw new ConnectError('agent stream cancelled', Code.Canceled);
    } catch (error: unknown) {
      if (error instanceof ConnectError) throw error;
      if (error instanceof NodeAuthenticationError)
        throw new ConnectError('node credentials are no longer valid', Code.Unauthenticated);
      throw new ConnectError('agent stream failed', Code.Internal);
    } finally {
      if (this.active.get(key) === controller) this.active.delete(key);
      // The transport aborts its request iterator when this response generator completes.
      // Do not await return() on an iterator blocked on a silent peer.
    }
  }
}

function waitForFrame<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | typeof tick> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(
        signal.reason instanceof ConnectError
          ? signal.reason
          : new ConnectError('agent stream cancelled', Code.Canceled),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(tick);
    }, pollMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(
          error instanceof Error ? error : new ConnectError('invalid stream input', Code.Internal),
        );
      },
    );
  });
}

function nextFrame<T>(reader: AsyncIterator<T>): Promise<IteratorResult<T>> {
  const pending = reader.next();
  // A socket may close while the database check is pending. Observe rejection immediately;
  // waitForFrame still propagates it unless this stream has already been cancelled.
  void pending.catch(() => undefined);
  return pending;
}
