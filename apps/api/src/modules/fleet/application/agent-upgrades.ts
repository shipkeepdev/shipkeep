import { create } from '@bufbuild/protobuf';
import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, SYSTEM_ACTOR } from '@shipkeep/domain';
import { CosignBundleSchema, UpgradeAgentSchema } from '@shipkeep/proto-ts';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import {
  resourceActor,
  type ResourceSecurityContext as SecurityContext,
} from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import { summarizeAction } from '../domain/agent-action';
import {
  type AgentUpgradeRecord,
  isAgentArchitecture,
  nextUpgradeStep,
  parseReleaseVersion,
  type ReleaseVersion,
  UPGRADE_TIMINGS,
  upgradeCandidates,
  type UpgradeStep,
} from '../domain/agent-upgrade';
import { agentUpgradeEnded, agentUpgradeStarted, agentUpgradeTurnEnded } from '../domain/events';
import { type NodeRecord, observedStatus } from '../domain/node';

import { AgentActions } from './agent-actions';
import {
  AGENT_ACTION_STORE,
  AGENT_RELEASES,
  AGENT_UPGRADE_STORE,
  type AgentActionStore,
  type AgentReleases,
  type AgentUpgradeStore,
  FLEET_TRANSACTION,
  type FleetTransaction,
  NODE_STORE,
  type NodeStore,
} from './ports';

/** The version agents are upgraded to: the control plane's own, `SHIPKEEP_VERSION`. */
export const CONTROL_PLANE_VERSION = Symbol('ControlPlaneVersion');

/** Runs a rollout again, after `delaySeconds`; joins the caller's transaction when there is one. */
export interface AgentUpgradeWaker {
  wake(organizationId: string, upgradeId: string, delaySeconds?: number): Promise<void>;
}
export const AGENT_UPGRADE_WAKER = Symbol('AgentUpgradeWaker');

/** The idempotency key of a server's UpgradeAgent in a rollout: one action per turn. */
export function upgradeActionKey(upgradeId: string, nodeId: string): string {
  return `au:${upgradeId}:${nodeId}`;
}
export const UPGRADE_ACTION_KEY = /^au:([0-9a-f-]{36}):/;

/** Most servers one rollout lists; the table refuses more. */
const MAX_NODES = 1000;

export interface AgentUpgradeOverview {
  /** The version agents go to; null on a development build of the control plane. */
  readonly version: string | null;
  /** The servers whose agent runs an older release, which a rollout would list now. */
  readonly pending: readonly string[];
  /** The organization's newest rollout, running or ended. */
  readonly rollout: AgentUpgradeRecord | null;
}

/**
 * Agent upgrades across an organization's servers (ADR 0028, section 2): one server at a time,
 * never while another action runs there, waiting for each agent to come back with the new version,
 * and stopping at the first failure. The queue runs `advance`; every change is audited.
 */
@Injectable()
export class AgentUpgrades {
  constructor(
    @Inject(CONTROL_PLANE_VERSION) private readonly version: string,
    @Inject(AGENT_UPGRADE_STORE) private readonly upgrades: AgentUpgradeStore,
    @Inject(NODE_STORE) private readonly nodes: NodeStore,
    @Inject(AGENT_ACTION_STORE) private readonly actionStore: AgentActionStore,
    @Inject(AGENT_RELEASES) private readonly releases: AgentReleases,
    @Inject(FLEET_TRANSACTION) private readonly transaction: FleetTransaction,
    @Inject(AGENT_UPGRADE_WAKER) private readonly waker: AgentUpgradeWaker,
    private readonly actions: AgentActions,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly events: DomainEventBus,
  ) {}

  /** What the fleet page shows; needs `node.manage`. */
  overview(context: SecurityContext, organizationId: string): Promise<AgentUpgradeOverview> {
    return this.accounts.run(context, async () => {
      await this.access.require(context.userId, 'node.manage', { organizationId });
      const target = parseReleaseVersion(this.version);
      return this.transaction.runTenant(organizationId, async () => ({
        version: target?.text ?? null,
        pending: target
          ? upgradeCandidates(target, await this.allNodes(organizationId)).map((node) => node.id)
          : [],
        rollout: (await this.upgrades.latest(organizationId)) ?? null,
      }));
    });
  }

  /**
   * Starts a rollout to the control plane's version, for every server on an older release; needs
   * `node.manage`. The caller names the version it saw, which must still be the control plane's.
   * The release is read for each architecture first: a version GitHub does not serve starts
   * nothing.
   */
  start(
    context: SecurityContext,
    organizationId: string,
    requested: string,
    now = new Date(),
  ): Promise<AgentUpgradeRecord> {
    const target = { organizationId };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, 'node.manage', target);
        const version = parseReleaseVersion(this.version);
        if (!version)
          throw new ConflictError(
            'agent_upgrade_unavailable',
            'This control plane is a development build: it has no release to upgrade agents to.',
          );
        if (requested !== version.text)
          throw new ConflictError(
            'agent_upgrade_version_changed',
            `The control plane runs ${version.text}, not ${requested}: reload and try again.`,
          );
        const candidates = await this.transaction.runTenant(organizationId, async () => {
          await this.refuseRunning(organizationId);
          return upgradeCandidates(version, await this.allNodes(organizationId)).sort((a, b) =>
            a.name.localeCompare(b.name),
          );
        });
        if (candidates.length === 0)
          throw new ConflictError(
            'agent_upgrade_not_needed',
            `Every agent already runs ${version.text} or a later version.`,
          );
        await this.checkReleases(version, candidates);
        return this.transaction.runTenant(organizationId, async () => {
          const record: AgentUpgradeRecord = {
            id: uuidv7(),
            organizationId,
            version: version.text,
            state: 'running',
            nodeIds: candidates.map((node) => node.id),
            position: 0,
            actionId: null,
            turnStartedAt: now,
            failure: null,
            requestedBy: context.apiCredential?.id ?? context.userId,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
          };
          if (!(await this.upgrades.insert(record))) await this.refuseRunning(organizationId, true);
          await this.events.publish([
            agentUpgradeStarted({
              organizationId,
              upgradeId: record.id,
              version: record.version,
              nodeIds: record.nodeIds,
              actor: resourceActor(context),
            }),
          ]);
          await this.waker.wake(organizationId, record.id);
          return record;
        });
      },
      { permission: 'node.manage', target },
    );
  }

  /**
   * One run of a rollout, from the queue: every turn that can end now ends. Returns the seconds
   * after which to run it again, or null once it ended.
   */
  async advance(
    organizationId: string,
    upgradeId: string,
    clock: () => Date = () => new Date(),
  ): Promise<number | null> {
    // Each turn moves the position, so a rollout of N servers ends in at most N + 1 turns.
    for (let turn = 0; turn <= MAX_NODES + 1; turn++) {
      const now = clock();
      const read = await this.transaction.runTenant(organizationId, async () => {
        const upgrade = await this.upgrades.findById(organizationId, upgradeId);
        if (!upgrade || upgrade.state !== 'running') return undefined;
        const step = await this.decide(upgrade, now);
        if (step.kind !== 'send') await this.apply(upgrade, step, now);
        return { upgrade, step };
      });
      if (!read) return null;
      const { upgrade, step } = read;
      switch (step.kind) {
        case 'wait':
          return step.seconds;
        case 'finish':
        case 'fail':
          return null;
        case 'send':
          return (await this.send(upgrade, step.architecture, now))
            ? UPGRADE_TIMINGS.pollSeconds
            : null;
        default:
          continue;
      }
    }
    return UPGRADE_TIMINGS.pollSeconds;
  }

  private async decide(upgrade: AgentUpgradeRecord, now: Date): Promise<UpgradeStep> {
    if (upgrade.position >= upgrade.nodeIds.length)
      return nextUpgradeStep({ upgrade, node: undefined, action: undefined, now });
    const nodeId = upgrade.nodeIds[upgrade.position] ?? '';
    const node = await this.nodes.findById(upgrade.organizationId, nodeId);
    const action = await this.actionStore.findByKey(
      upgrade.organizationId,
      nodeId,
      upgradeActionKey(upgrade.id, nodeId),
    );
    return nextUpgradeStep({
      upgrade,
      node: node && {
        status: observedStatus(node, now),
        agentVersion: node.facts['agent_version'],
        architecture: node.facts['architecture'],
        lastHeartbeatAt: node.lastHeartbeatAt,
        busy: await this.actionStore.hasUnfinished(
          upgrade.organizationId,
          nodeId,
          action?.id ?? null,
          now,
        ),
      },
      action: action && {
        state: action.state,
        reason: summarizeAction(action).reason,
        completedAt: action.completedAt,
      },
      now,
    });
  }

  /** Records a step other than `send`, with its audit event, in the caller's transaction. */
  private async apply(upgrade: AgentUpgradeRecord, step: UpgradeStep, now: Date): Promise<void> {
    const nodeId = upgrade.nodeIds[upgrade.position] ?? '';
    const base = { organizationId: upgrade.organizationId, upgradeId: upgrade.id };
    switch (step.kind) {
      case 'wait':
      case 'send':
        return;
      case 'skip':
      case 'done':
        await this.change(upgrade, {
          position: upgrade.position + 1,
          actionId: null,
          turnStartedAt: now,
          updatedAt: now,
        });
        await this.events.publish([
          agentUpgradeTurnEnded({
            ...base,
            nodeId,
            outcome: step.kind === 'done' ? 'upgraded' : 'skipped',
          }),
        ]);
        return;
      case 'finish':
        await this.change(upgrade, { state: 'succeeded', updatedAt: now, completedAt: now });
        await this.events.publish([
          agentUpgradeEnded({ ...base, version: upgrade.version, failure: null }),
        ]);
        return;
      case 'fail': {
        const failure = { nodeId, reason: step.reason, actionReason: step.actionReason };
        await this.change(upgrade, { state: 'failed', failure, updatedAt: now, completedAt: now });
        await this.events.publish([
          agentUpgradeEnded({ ...base, version: upgrade.version, failure }),
        ]);
      }
    }
  }

  /**
   * Sends the turn's UpgradeAgent. The release is read outside any transaction; the action and the
   * turn's new start are then written together, on the turn just read. False when the rollout
   * stopped instead, because the release could not be read.
   */
  private async send(
    upgrade: AgentUpgradeRecord,
    architecture: Parameters<AgentReleases['find']>[1],
    now: Date,
  ): Promise<boolean> {
    const nodeId = upgrade.nodeIds[upgrade.position] ?? '';
    const version = parseReleaseVersion(upgrade.version);
    const release = version ? await this.releases.find(version, architecture) : null;
    return this.transaction.runTenant(upgrade.organizationId, async () => {
      if (!release) {
        await this.apply(
          upgrade,
          { kind: 'fail', reason: 'release_unavailable', actionReason: null },
          now,
        );
        return false;
      }
      const { id } = await this.actions.enqueue(
        {
          organizationId: upgrade.organizationId,
          nodeId,
          idempotencyKey: upgradeActionKey(upgrade.id, nodeId),
          action: {
            case: 'upgradeAgent',
            value: create(UpgradeAgentSchema, {
              version: upgrade.version,
              url: release.url,
              sha256: release.sha256,
              cosignBundle: create(CosignBundleSchema, { bundleJson: release.bundleJson }),
            }),
          },
          deadline: new Date(now.getTime() + UPGRADE_TIMINGS.actionMs),
          actor: SYSTEM_ACTOR,
        },
        now,
      );
      // From now on, the turn's timings count from the action, not from the wait before it.
      await this.change(upgrade, { actionId: id, turnStartedAt: now, updatedAt: now });
      return true;
    });
  }

  /** Compare-and-swap on the turn just read: another run that moved first rolls this one back. */
  private async change(
    upgrade: AgentUpgradeRecord,
    change: Partial<Parameters<AgentUpgradeStore['update']>[3]> & { readonly updatedAt: Date },
  ): Promise<void> {
    const updated = await this.upgrades.update(
      upgrade.organizationId,
      upgrade.id,
      { position: upgrade.position, actionId: upgrade.actionId },
      {
        state: upgrade.state,
        position: upgrade.position,
        actionId: upgrade.actionId,
        turnStartedAt: upgrade.turnStartedAt,
        failure: upgrade.failure,
        completedAt: upgrade.completedAt,
        ...change,
      },
    );
    if (!updated)
      throw new ConflictError('agent_upgrade_changed', 'The agent upgrade changed meanwhile.');
  }

  private async refuseRunning(organizationId: string, raced = false): Promise<void> {
    if (raced || (await this.upgrades.findRunning(organizationId)))
      throw new ConflictError(
        'agent_upgrade_running',
        'An agent upgrade is already running in this organization.',
      );
  }

  /** Every node of the organization, at most MAX_NODES. */
  private async allNodes(organizationId: string): Promise<NodeRecord[]> {
    const nodes: NodeRecord[] = [];
    for (let page = await this.nodes.list(organizationId); page.length > 0;) {
      nodes.push(...page);
      if (nodes.length > MAX_NODES)
        throw new ConflictError(
          'agent_upgrade_too_many',
          `A rollout upgrades at most ${String(MAX_NODES)} servers.`,
        );
      page = await this.nodes.list(organizationId, page.at(-1)?.id);
    }
    return nodes;
  }

  private async checkReleases(
    version: ReleaseVersion,
    nodes: readonly NodeRecord[],
  ): Promise<void> {
    const architectures = new Set(
      nodes.map((node) => node.facts['architecture']).filter(isAgentArchitecture),
    );
    for (const architecture of architectures)
      if (!(await this.releases.find(version, architecture)))
        throw new ConflictError(
          'agent_release_unavailable',
          `The release ${version.text} could not be read from GitHub: check that the control plane reaches github.com.`,
        );
  }
}
