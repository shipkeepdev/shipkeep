import { Injectable } from '@angular/core';

import { type Schema, WorkspaceApi } from '../workspace/workspace-api';

export type Application = Schema<'ApplicationDto'>;
export type Deployment = Schema<'DeploymentDto'>;
export type SecretMetadata = Schema<'SecretDto'>;
export type DomainStatus = Schema<'DomainDto'>;
export type Replica = Schema<'ReplicaDto'>;
export type Release = Schema<'ReleaseDto'>;
export type AgentAction = Schema<'AgentActionDto'>;

/** Agent actions per page on the application screen. */
export const AGENT_ACTION_PAGE = 20;

/** The environment an application lives in; every route below is scoped by it. */
export interface EnvironmentRef {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

/** Applications, deployments and write-only secrets of an environment. */
@Injectable({ providedIn: 'root' })
export class DeliveryApi extends WorkspaceApi {
  async applications(environment: EnvironmentRef): Promise<readonly Application[]> {
    return (
      await this.required(() =>
        this.client.GET(
          '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications',
          { params: { path: { ...environment } } },
        ),
      )
    ).items;
  }
  application(environment: EnvironmentRef, applicationId: string): Promise<Application> {
    return this.required(() =>
      this.client.GET(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}',
        { params: { path: { ...environment, applicationId } } },
      ),
    );
  }
  createApplication(environment: EnvironmentRef, config: object): Promise<Application> {
    return this.required(() =>
      this.client.POST(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications',
        {
          body: { config: { ...config } },
          params: { path: { ...environment } },
        },
      ),
    );
  }
  updateConfig(
    environment: EnvironmentRef,
    applicationId: string,
    expectedConfigSha: string,
    config: object,
  ): Promise<Application> {
    return this.required(() =>
      this.client.POST(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/config',
        {
          params: { path: { ...environment, applicationId } },
          body: { expectedConfigSha, config: { ...config } },
        },
      ),
    );
  }
  async replicas(environment: EnvironmentRef, applicationId: string): Promise<readonly Replica[]> {
    return (
      await this.required(() =>
        this.client.GET(
          '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/replicas',
          { params: { path: { ...environment, applicationId } } },
        ),
      )
    ).items;
  }
  async releases(environment: EnvironmentRef, applicationId: string): Promise<readonly Release[]> {
    return (
      await this.required(() =>
        this.client.GET(
          '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/releases',
          { params: { path: { ...environment, applicationId } } },
        ),
      )
    ).items;
  }
  /** Newest first; `cursor` is the last id of the page before. */
  agentActions(
    environment: EnvironmentRef,
    applicationId: string,
    cursor?: string,
  ): Promise<Schema<'AgentActionPageDto'>> {
    return this.required(() =>
      this.client.GET(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/agent-actions',
        {
          params: {
            path: { ...environment, applicationId },
            query: { limit: AGENT_ACTION_PAGE, ...(cursor ? { cursor } : {}) },
          },
        },
      ),
    );
  }
  async domains(
    environment: EnvironmentRef,
    applicationId: string,
  ): Promise<readonly Schema<'DomainDto'>[]> {
    return (
      await this.required(() =>
        this.client.GET(
          '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/domains',
          { params: { path: { ...environment, applicationId } } },
        ),
      )
    ).items;
  }
  deploy(
    environment: EnvironmentRef,
    applicationId: string,
  ): Promise<Schema<'QueuedDeploymentDto'>> {
    return this.required(() =>
      this.client.POST(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/deployments',
        {
          params: { path: { ...environment, applicationId } },
        },
      ),
    );
  }
  async deployments(
    environment: EnvironmentRef,
    applicationId: string,
  ): Promise<readonly Deployment[]> {
    return (
      await this.required(() =>
        this.client.GET(
          '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/deployments',
          {
            params: { path: { ...environment, applicationId } },
          },
        ),
      )
    ).items;
  }
  cancel(
    environment: EnvironmentRef,
    applicationId: string,
    deploymentId: string,
  ): Promise<Deployment> {
    return this.required(() =>
      this.client.POST(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/deployments/{deploymentId}/cancel',
        {
          params: { path: { ...environment, applicationId, deploymentId } },
        },
      ),
    );
  }
  rollback(
    environment: EnvironmentRef,
    applicationId: string,
    deploymentId: string,
  ): Promise<Schema<'QueuedDeploymentDto'>> {
    return this.required(() =>
      this.client.POST(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/deployments/{deploymentId}/rollback',
        { params: { path: { ...environment, applicationId, deploymentId } } },
      ),
    );
  }
  async secrets(environment: EnvironmentRef): Promise<readonly SecretMetadata[]> {
    return (
      await this.required(() =>
        this.client.GET(
          '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/secrets',
          { params: { path: { ...environment } } },
        ),
      )
    ).items;
  }
  setSecret(environment: EnvironmentRef, name: string, value: string): Promise<SecretMetadata> {
    return this.required(() =>
      this.client.POST(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/secrets',
        {
          body: { name, value },
          params: { path: { ...environment } },
        },
      ),
    );
  }
  async removeSecret(environment: EnvironmentRef, name: string): Promise<void> {
    await this.execute(() =>
      this.client.POST(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/secrets/{name}/remove',
        {
          params: { path: { ...environment, name } },
        },
      ),
    );
  }
}
