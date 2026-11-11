import { create, fromBinary, toBinary, toJson } from '@bufbuild/protobuf';
import { Inject, Injectable } from '@nestjs/common';
import {
  type Actor,
  createEvent,
  InvalidInputError,
  isTenantId,
  NotFoundError,
} from '@shipkeep/domain';
import {
  ACTION_KINDS,
  type ActionKind,
  type ActionRequest,
  ActionRequestSchema,
  ActionResultSchema,
  type ActionUpdate,
  OperationState,
} from '@shipkeep/proto-ts';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import {
  type AgentActionRecord,
  type AgentActionState,
  IDEMPOTENCY_KEY,
  isTerminalAction,
  MAX_ACTION_LIFETIME_MS,
} from '../domain/agent-action';
import { sanitizeFacts } from '../domain/node';
import type { NodeIdentity } from '../domain/node-identity';

import { factsFromProto } from './node-facts';
import {
  AGENT_ACTION_STORE,
  type AgentActionStore,
  FLEET_TRANSACTION,
  type FleetTransaction,
  NODE_STORE,
  type NodeStore,
} from './ports';

const STATES: Readonly<Partial<Record<OperationState, AgentActionState>>> = {
  [OperationState.PENDING]: 'pending',
  [OperationState.RUNNING]: 'running',
  [OperationState.SUCCEEDED]: 'succeeded',
  [OperationState.FAILED]: 'failed',
  [OperationState.CANCELLED]: 'cancelled',
  [OperationState.COMPENSATING]: 'compensating',
  [OperationState.COMPENSATED]: 'compensated',
};
const STEP = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/**
 * Durable action queue between the control plane and its agents (PLAN M1.4a2). Delivery is at
 * least once: every stream (re)delivers the node's unfinished actions, and the agent journal
 * replays a known idempotency key instead of executing it twice.
 */
@Injectable()
export class AgentActions {
  constructor(
    @Inject(AGENT_ACTION_STORE) private readonly store: AgentActionStore,
    @Inject(NODE_STORE) private readonly nodes: NodeStore,
    @Inject(FLEET_TRANSACTION) private readonly transaction: FleetTransaction,
    private readonly events: DomainEventBus,
  ) {}

  /** Queues `action` for a node. The same idempotency key returns the existing action. */
  async enqueue(
    input: {
      organizationId: string;
      nodeId: string;
      idempotencyKey: string;
      action: ActionRequest['action'];
      deadline: Date;
      actor: Actor;
      /** The deployment that needs the action, listed in its application's history. */
      origin?: { applicationId: string; deploymentId: string };
    },
    now = new Date(),
  ): Promise<{ id: string; created: boolean }> {
    const kind = input.action.case;
    const lifetime = input.deadline.getTime() - now.getTime();
    if (
      !kind ||
      !ACTION_KINDS.includes(kind) ||
      !IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
      !isTenantId(input.nodeId) ||
      (input.origin &&
        !(isTenantId(input.origin.applicationId) && isTenantId(input.origin.deploymentId))) ||
      !(lifetime > 0 && lifetime <= MAX_ACTION_LIFETIME_MS)
    )
      throw new InvalidInputError('invalid_agent_action', 'Invalid agent action request.');
    return this.transaction.runTenant(input.organizationId, async () => {
      const node = await this.nodes.findById(input.organizationId, input.nodeId);
      if (!node || node.status === 'removed') throw new NotFoundError('resource');
      const existing = await this.store.findByKey(
        input.organizationId,
        input.nodeId,
        input.idempotencyKey,
      );
      if (existing) return { id: existing.id, created: false };
      const record: AgentActionRecord = {
        id: uuidv7(),
        organizationId: input.organizationId,
        nodeId: input.nodeId,
        kind,
        idempotencyKey: input.idempotencyKey,
        payload: toBinary(
          ActionRequestSchema,
          create(ActionRequestSchema, { action: input.action }),
        ),
        leaseEpoch: node.leaseEpoch,
        deadline: input.deadline,
        state: 'queued',
        step: '',
        attempts: 0,
        result: null,
        error: null,
        requestedBy: input.actor.id ?? null,
        applicationId: input.origin?.applicationId ?? null,
        deploymentId: input.origin?.deploymentId ?? null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      if (!(await this.store.insert(record))) {
        const winner = await this.store.findByKey(
          input.organizationId,
          input.nodeId,
          input.idempotencyKey,
        );
        if (!winner) throw new NotFoundError('resource');
        return { id: winner.id, created: false };
      }
      await this.events.publish([
        this.event('queued', record, input.actor, { idempotencyKey: record.idempotencyKey }),
      ]);
      return { id: record.id, created: true };
    });
  }

  /** Unfinished actions of the node not yet sent on this stream; overdue ones expire first. */
  async deliverable(
    identity: NodeIdentity,
    sent: ReadonlySet<string>,
    now = new Date(),
  ): Promise<ActionRequest[]> {
    return this.transaction.runTenant(identity.organizationId, async () => {
      const expired = await this.store.expire(identity.organizationId, identity.nodeId, now);
      if (expired.length)
        await this.events.publish(
          expired.map((record) =>
            this.event(
              'expired',
              record,
              { kind: 'system' },
              { idempotencyKey: record.idempotencyKey },
            ),
          ),
        );
      const records = await this.store.deliverable(identity.organizationId, identity.nodeId, now);
      return records
        .filter((record) => !sent.has(record.id))
        .map((record) =>
          create(ActionRequestSchema, {
            ...fromBinary(ActionRequestSchema, record.payload),
            actionId: record.id,
            idempotencyKey: record.idempotencyKey,
            deadlineUnixMs: BigInt(record.deadline.getTime()),
            leaseEpoch: BigInt(record.leaseEpoch),
          }),
        );
    });
  }

  /** Records an agent update for one of its own actions; foreign or unknown ids are ignored. */
  async record(identity: NodeIdentity, update: ActionUpdate, now = new Date()): Promise<void> {
    const state = STATES[update.state];
    if (!isTenantId(update.actionId) || !state) return;
    const step = STEP.test(update.step) ? update.step : '';
    const result = update.result ? toJson(ActionResultSchema, update.result) : null;
    await this.transaction.runTenant(identity.organizationId, async () => {
      const changed = await this.store.apply(
        identity.organizationId,
        identity.nodeId,
        update.actionId,
        {
          state,
          step,
          attempts: Math.min(update.attempts, 1_000_000),
          result,
          // Agents send fixed, redacted messages; keep them bounded anyway.
          error: update.error ? update.error.slice(0, 256) : null,
          at: now,
        },
      );
      // A CollectFacts result refreshes the node's capacity and versions (scheduling input).
      if (changed?.state === 'succeeded' && update.result?.result.case === 'facts')
        await this.nodes.updateFacts(
          identity.organizationId,
          identity.nodeId,
          sanitizeFacts(factsFromProto(update.result.result.value)),
        );
      if (changed && isTerminalAction(changed.state))
        await this.events.publish([
          this.event(
            changed.state,
            changed,
            { kind: 'node', id: identity.nodeId },
            {
              step: changed.step,
              // Owners of the action (the deployment pipeline) wake up on its key.
              idempotencyKey: changed.idempotencyKey,
              ...(changed.error ? { error: changed.error } : {}),
            },
          ),
        ]);
    });
  }

  private event(
    what: string,
    record: AgentActionRecord,
    actor: Actor,
    payload: Record<string, unknown>,
  ) {
    return createEvent({
      type: `fleet.action.${what}`,
      organizationId: record.organizationId,
      actor,
      target: { type: 'agent_action', id: record.id },
      payload: { nodeId: record.nodeId, kind: record.kind as ActionKind, ...payload },
    });
  }
}
