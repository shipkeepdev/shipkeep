import { Injectable } from '@angular/core';

import { type Schema, WorkspaceApi } from '../workspace/workspace-api';

export type Member = Schema<'MemberViewDto'>;
export type Binding = Schema<'BindingViewDto'>;
export type OrganizationRole = Member['orgRole'];
export type ResourceRole = Binding['role'];
export type Proof = Schema<'ReauthenticateMfaDto'>;
/** A project, or one of its environments when `environmentId` is set. */
export interface BindingScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId?: string;
}

/** Who can do what: organization members and project or environment roles (SPEC 7). */
@Injectable({ providedIn: 'root' })
export class AccessApi extends WorkspaceApi {
  members(organizationId: string, cursor?: string): Promise<Schema<'MemberPageDto'>> {
    return this.required(() =>
      this.client.GET('/api/v1/organizations/{organizationId}/members', {
        params: { path: { organizationId }, query: cursor ? { cursor } : {} },
      }),
    );
  }
  async addMember(
    organizationId: string,
    body: Schema<'AddMemberDto'>,
    key: string,
  ): Promise<void> {
    await this.required(() =>
      this.client.POST('/api/v1/organizations/{organizationId}/members', {
        body,
        params: { ...this.mutation(key), path: { organizationId } },
      }),
    );
  }
  async changeRole(
    organizationId: string,
    membershipId: string,
    body: Schema<'MemberRoleDto'>,
    key: string,
  ): Promise<void> {
    await this.required(() =>
      this.client.POST('/api/v1/organizations/{organizationId}/members/{membershipId}/role', {
        body,
        params: { ...this.mutation(key), path: { organizationId, membershipId } },
      }),
    );
  }
  async removeMember(
    organizationId: string,
    membershipId: string,
    body: Proof,
    key: string,
  ): Promise<void> {
    await this.required(() =>
      this.client.POST('/api/v1/organizations/{organizationId}/members/{membershipId}/remove', {
        body,
        params: { ...this.mutation(key), path: { organizationId, membershipId } },
      }),
    );
  }
  bindings(scope: BindingScope, cursor?: string): Promise<Schema<'BindingPageDto'>> {
    const { organizationId, projectId, environmentId } = scope;
    const query = cursor ? { cursor } : {};
    return this.required(() =>
      environmentId
        ? this.client.GET(
            '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/bindings',
            { params: { path: { organizationId, projectId, environmentId }, query } },
          )
        : this.client.GET('/api/v1/organizations/{organizationId}/projects/{projectId}/bindings', {
            params: { path: { organizationId, projectId }, query },
          }),
    );
  }
  async assignBinding(
    scope: BindingScope,
    body: Schema<'AssignBindingDto'>,
    key: string,
  ): Promise<void> {
    const { organizationId, projectId, environmentId } = scope;
    await this.required(() =>
      environmentId
        ? this.client.POST(
            '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/bindings',
            {
              body,
              params: {
                ...this.mutation(key),
                path: { organizationId, projectId, environmentId },
              },
            },
          )
        : this.client.POST('/api/v1/organizations/{organizationId}/projects/{projectId}/bindings', {
            body,
            params: { ...this.mutation(key), path: { organizationId, projectId } },
          }),
    );
  }
  async removeBinding(
    scope: BindingScope,
    membershipId: string,
    body: Proof,
    key: string,
  ): Promise<void> {
    const { organizationId, projectId, environmentId } = scope;
    await this.required(() =>
      environmentId
        ? this.client.POST(
            '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/bindings/{membershipId}/remove',
            {
              body,
              params: {
                ...this.mutation(key),
                path: { organizationId, projectId, environmentId, membershipId },
              },
            },
          )
        : this.client.POST(
            '/api/v1/organizations/{organizationId}/projects/{projectId}/bindings/{membershipId}/remove',
            {
              body,
              params: { ...this.mutation(key), path: { organizationId, projectId, membershipId } },
            },
          ),
    );
  }
}
