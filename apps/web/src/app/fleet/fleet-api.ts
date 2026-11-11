import { Injectable } from '@angular/core';

import { type Schema, WorkspaceApi } from '../workspace/workspace-api';

export type FleetNode = Schema<'NodeDto'>;
export type JoinToken = Schema<'JoinTokenIssuedDto'>;

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
  issueJoinToken(organizationId: string, body: Schema<'ReauthenticateMfaDto'>): Promise<JoinToken> {
    return this.required(() =>
      this.client.POST('/api/v1/organizations/{organizationId}/join-tokens', {
        body,
        params: { path: { organizationId }, header: this.browser() },
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
  /** Values the browser request filter replaces; required by the generated types. */
  private browser(): { Origin: string; 'X-Shipkeep-CSRF': string } {
    return { Origin: this.origin, 'X-Shipkeep-CSRF': '' };
  }
}
