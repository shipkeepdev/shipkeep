import { Injectable } from '@angular/core';

import { type Schema, WorkspaceApi } from '../workspace/workspace-api';

export type Application = Schema<'ApplicationDto'>;
export type Deployment = Schema<'DeploymentDto'>;
export type SecretMetadata = Schema<'SecretDto'>;
export type DomainStatus = Schema<'DomainDto'>;
export type Replica = Schema<'ReplicaDto'>;
export type Release = Schema<'ReleaseDto'>;
export type AgentAction = Schema<'AgentActionDto'>;
export type DeploymentTimeline = Schema<'DeploymentTimelineDto'>;
export type DeploymentStep = Schema<'DeploymentStepDto'>;
export type ApplicationMetrics = Schema<'ApplicationMetricsDto'>;
export type MetricsRange = '1h' | '24h' | '7d';
export type ApplicationLogs = Schema<'LogsDto'>;
export type LogLine = Schema<'LogLineDto'>;
export type ExecSession = Schema<'ExecSessionDto'>;

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
  /** A new environment with copies of these applications, not deployed (issue #257). */
  cloneEnvironment(
    environment: EnvironmentRef,
    name: string,
  ): Promise<Schema<'ClonedEnvironmentDto'>> {
    return this.required(() =>
      this.client.POST(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/clone',
        { body: { name }, params: { path: { ...environment } } },
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
  /** CPU, memory, requests by status and mean response time over the period (ADR 0024). */
  async metrics(
    environment: EnvironmentRef,
    applicationId: string,
    range: MetricsRange,
  ): Promise<ApplicationMetrics> {
    return this.required(() =>
      this.client.GET(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/metrics',
        { params: { path: { ...environment, applicationId }, query: { range } } },
      ),
    );
  }
  /** The application's log lines, newest first (ADR 0029). */
  async logs(
    environment: EnvironmentRef,
    applicationId: string,
    query: { text?: string; stream?: 'stdout' | 'stderr'; from?: string; limit?: number },
  ): Promise<ApplicationLogs> {
    return this.required(() =>
      this.client.GET(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/logs',
        { params: { path: { ...environment, applicationId }, query } },
      ),
    );
  }
  /** Opens an exec session in a running replica; the browser then joins it over a WebSocket. */
  openExecSession(
    environment: EnvironmentRef,
    applicationId: string,
    body: { replica: number; argv: readonly string[]; tty: boolean; minutes: number },
  ): Promise<ExecSession> {
    return this.required(() =>
      this.client.POST(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/exec-sessions',
        { params: { path: { ...environment, applicationId } }, body },
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
  deployment(
    environment: EnvironmentRef,
    applicationId: string,
    deploymentId: string,
  ): Promise<Deployment> {
    return this.required(() =>
      this.client.GET(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/deployments/{deploymentId}',
        { params: { path: { ...environment, applicationId, deploymentId } } },
      ),
    );
  }
  /** What one deployment went through: its steps and agent actions, oldest first (#265). */
  timeline(
    environment: EnvironmentRef,
    applicationId: string,
    deploymentId: string,
  ): Promise<DeploymentTimeline> {
    return this.required(() =>
      this.client.GET(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/deployments/{deploymentId}/timeline',
        { params: { path: { ...environment, applicationId, deploymentId } } },
      ),
    );
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
  /** Queues a stop: the routes and replicas are removed, the application and its history stay. */
  stop(environment: EnvironmentRef, applicationId: string): Promise<Deployment> {
    return this.required(() =>
      this.client.POST(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/stop',
        { params: { path: { ...environment, applicationId } } },
      ),
    );
  }
  /**
   * Queues entering or leaving maintenance (ADR 0025): the routes serve the agent's maintenance
   * page, or the replicas again. The replicas keep running either way.
   */
  maintenance(
    environment: EnvironmentRef,
    applicationId: string,
    change: 'enter' | 'leave',
  ): Promise<Deployment> {
    return this.required(() =>
      change === 'enter'
        ? this.client.POST(
            '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/maintenance/enter',
            { params: { path: { ...environment, applicationId } } },
          )
        : this.client.POST(
            '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/maintenance/leave',
            { params: { path: { ...environment, applicationId } } },
          ),
    );
  }
  /** Single-use token proving the user typed the application's exact name (SPEC 3.6). */
  async confirmDeletion(
    organizationId: string,
    application: Pick<Application, 'id'>,
    name: string,
  ): Promise<string> {
    return (
      await this.required(() =>
        this.client.POST('/api/v1/organizations/{organizationId}/confirmations', {
          body: { action: 'application.delete', target: application.id, name },
          // Values the browser request filter replaces; required by the generated types.
          params: {
            path: { organizationId },
            header: { Origin: this.origin, 'X-Shipkeep-CSRF': '' },
          },
        }),
      )
    ).token;
  }
  async deleteApplication(
    environment: EnvironmentRef,
    applicationId: string,
    confirmation: string,
  ): Promise<void> {
    await this.execute(() =>
      this.client.POST(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/applications/{applicationId}/delete',
        { body: { confirmation }, params: { path: { ...environment, applicationId } } },
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
