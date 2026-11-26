import { Injectable } from '@angular/core';

import type { MetricsRange } from '../delivery/delivery-api';
import { type Schema, WorkspaceApi } from '../workspace/workspace-api';

export type FleetNode = Schema<'NodeDto'>;
export type NodeMetrics = Schema<'NodeMetricsDto'>;
export type JoinToken = Schema<'JoinTokenIssuedDto'>;
export type NodeReplica = Schema<'NodeReplicaDto'>;
export type NodeReplicaList = Schema<'NodeReplicaListDto'>;
export type AgentUpgradeOverview = Schema<'AgentUpgradeOverviewDto'>;
export type AgentUpgrade = Schema<'AgentUpgradeDto'>;
export type UntrackedContainer = Schema<'UntrackedContainerDto'>;
export type NodeReadoption = Schema<'NodeReadoptionDto'>;

/**
 * Servers of an organization: listing, enrollment tokens, declared public addresses and confirmed
 * removal (SPEC 3.2, 3.6).
 */
@Injectable({ providedIn: 'root' })
export class FleetApi extends WorkspaceApi {
  async nodes(organizationId: string): Promise<readonly FleetNode[]> {
    return (
      await this.required(() =>
        this.client.GET('/api/v1/organizations/{organizationId}/nodes', {
          params: { path: { organizationId } },
        }),
      )
    ).items;
  }
  /** One server, removed ones included (#264). */
  node(organizationId: string, nodeId: string): Promise<FleetNode> {
    return this.required(() =>
      this.client.GET('/api/v1/organizations/{organizationId}/nodes/{nodeId}', {
        params: { path: { organizationId, nodeId } },
      }),
    );
  }
  /** The replicas placed on a server, at most 200, by application name (#264). */
  nodeReplicas(organizationId: string, nodeId: string): Promise<NodeReplicaList> {
    return this.required(() =>
      this.client.GET('/api/v1/organizations/{organizationId}/nodes/{nodeId}/replicas', {
        params: { path: { organizationId, nodeId } },
      }),
    );
  }
  issueJoinToken(organizationId: string, body: Schema<'ReauthenticateMfaDto'>): Promise<JoinToken> {
    return this.required(() =>
      this.client.POST('/api/v1/organizations/{organizationId}/join-tokens', {
        body,
        params: { path: { organizationId }, header: this.browser() },
      }),
    );
  }
  /** Containers the server runs that no placed replica matches, of known applications (#501). */
  async untrackedContainers(
    organizationId: string,
    nodeId: string,
  ): Promise<readonly UntrackedContainer[]> {
    return (
      await this.required(() =>
        this.client.GET(
          '/api/v1/organizations/{organizationId}/nodes/{nodeId}/untracked-containers',
          {
            params: { path: { organizationId, nodeId } },
          },
        ),
      )
    ).items;
  }
  /** Single-use token proving the user typed the container's exact name (SPEC 3.6, #501). */
  async confirmContainerRemoval(
    organizationId: string,
    nodeId: string,
    container: string,
    name: string,
  ): Promise<string> {
    return (
      await this.required(() =>
        this.client.POST('/api/v1/organizations/{organizationId}/confirmations', {
          body: { action: 'node.container.remove', target: `${nodeId}/${container}`, name },
          params: { path: { organizationId }, header: this.browser() },
        }),
      )
    ).token;
  }
  /** Asks the server to remove an untracked container, without its volumes (#501). */
  async removeUntrackedContainer(
    organizationId: string,
    nodeId: string,
    name: string,
    confirmation: string,
  ): Promise<void> {
    await this.required(() =>
      this.client.POST(
        '/api/v1/organizations/{organizationId}/nodes/{nodeId}/untracked-containers/{name}/remove',
        {
          body: { confirmation },
          params: { path: { organizationId, nodeId, name }, header: this.browser() },
        },
      ),
    );
  }
  /** Certificates the gateway refused for a server after a restore, waiting for an administrator (#487). */
  async readoptions(organizationId: string): Promise<readonly NodeReadoption[]> {
    return (
      await this.required(() =>
        this.client.GET('/api/v1/organizations/{organizationId}/node-readoptions', {
          params: { path: { organizationId } },
        }),
      )
    ).items;
  }
  /** Registers the server's waiting certificate: the caller's password and second factor (#487). */
  async readopt(
    organizationId: string,
    nodeId: string,
    body: Schema<'ReauthenticateMfaDto'>,
  ): Promise<void> {
    await this.required(() =>
      this.client.POST('/api/v1/organizations/{organizationId}/nodes/{nodeId}/readopt', {
        body,
        params: { path: { organizationId, nodeId }, header: this.browser() },
      }),
    );
  }
  /** Single-use token proving the user typed the server's exact name (SPEC 3.6). */
  async confirmRemoval(organizationId: string, node: FleetNode, name: string): Promise<string> {
    return (
      await this.required(() =>
        this.client.POST('/api/v1/organizations/{organizationId}/confirmations', {
          body: { action: 'node.remove', target: node.id, name },
          params: { path: { organizationId }, header: this.browser() },
        }),
      )
    ).token;
  }
  async removeNode(organizationId: string, nodeId: string, confirmation: string): Promise<void> {
    await this.execute(() =>
      this.client.POST('/api/v1/organizations/{organizationId}/nodes/{nodeId}/remove', {
        body: { confirmation },
        params: { path: { organizationId, nodeId }, header: this.browser() },
      }),
    );
  }
  /** Replaces the addresses the domain check compares DNS answers with (PLAN M3.6b1). */
  setPublicAddresses(
    organizationId: string,
    nodeId: string,
    publicAddresses: readonly string[],
  ): Promise<FleetNode> {
    return this.required(() =>
      this.client.POST('/api/v1/organizations/{organizationId}/nodes/{nodeId}/public-addresses', {
        body: { publicAddresses: [...publicAddresses] },
        params: { path: { organizationId, nodeId }, header: this.browser() },
      }),
    );
  }
  /** CPU, memory, disk and network of a server over the period (ADR 0024). */
  nodeMetrics(organizationId: string, nodeId: string, range: MetricsRange): Promise<NodeMetrics> {
    return this.required(() =>
      this.client.GET('/api/v1/organizations/{organizationId}/nodes/{nodeId}/metrics', {
        params: { path: { organizationId, nodeId }, query: { range } },
      }),
    );
  }
  /** The agents' target version, the servers on an older release and the newest rollout (ADR 0028). */
  agentUpgrades(organizationId: string): Promise<AgentUpgradeOverview> {
    return this.required(() =>
      this.client.GET('/api/v1/organizations/{organizationId}/agent-upgrades', {
        params: { path: { organizationId } },
      }),
    );
  }
  /** Upgrades every agent on an older release to `version`, the control plane's, one at a time. */
  startAgentUpgrade(organizationId: string, version: string): Promise<AgentUpgrade> {
    return this.required(() =>
      this.client.POST('/api/v1/organizations/{organizationId}/agent-upgrades', {
        body: { version },
        params: { path: { organizationId }, header: this.browser() },
      }),
    );
  }
  /** Values the browser request filter replaces; required by the generated types. */
  private browser(): { Origin: string; 'X-Shipkeep-CSRF': string } {
    return { Origin: this.origin, 'X-Shipkeep-CSRF': '' };
  }
}
