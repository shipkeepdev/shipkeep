import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { type components, createShipkeepClient } from '@shipkeep/api-client';

import { browserRequest, IDENTITY_FETCH, IdentityRequestError } from '../identity/identity-api';

export type Schema<T extends keyof components['schemas']> = components['schemas'][T];
export type Organization = Schema<'OrganizationDto'>;
export type Project = Schema<'ProjectDto'>;
export type Environment = Schema<'EnvironmentDto'>;
type Result<T> = { data?: T; response: Response };

/** Session-cookie client for organizations, projects and environments (same origin only). */
@Injectable({ providedIn: 'root' })
export class WorkspaceApi {
  private readonly document = inject(DOCUMENT);
  private readonly send = inject(IDENTITY_FETCH);
  private readonly origin = this.document.location.origin;
  protected readonly client = createShipkeepClient({
    baseUrl: this.origin,
    fetch: (input: Request) => this.send(browserRequest(input, this.origin, this.document.cookie)),
  });

  async organizations(): Promise<readonly Organization[]> {
    return (await this.required(() => this.client.GET('/api/v1/organizations'))).items;
  }
  organization(organizationId: string): Promise<Organization> {
    return this.required(() =>
      this.client.GET('/api/v1/organizations/{organizationId}', {
        params: { path: { organizationId } },
      }),
    );
  }
  createOrganization(
    body: Schema<'CreateOrganizationDto'>,
    key: string,
  ): Promise<Schema<'OrganizationCreatedDto'>> {
    return this.required(() =>
      this.client.POST('/api/v1/organizations', { body, params: this.mutation(key) }),
    );
  }
  async projects(organizationId: string): Promise<readonly Project[]> {
    return (
      await this.required(() =>
        this.client.GET('/api/v1/organizations/{organizationId}/projects', {
          params: { path: { organizationId } },
        }),
      )
    ).items;
  }
  project(organizationId: string, projectId: string): Promise<Project> {
    return this.required(() =>
      this.client.GET('/api/v1/organizations/{organizationId}/projects/{projectId}', {
        params: { path: { organizationId, projectId } },
      }),
    );
  }
  createProject(
    organizationId: string,
    body: Schema<'ProjectSettingsDto'>,
    key: string,
  ): Promise<Project> {
    return this.required(() =>
      this.client.POST('/api/v1/organizations/{organizationId}/projects', {
        body,
        params: { ...this.mutation(key), path: { organizationId } },
      }),
    );
  }
  async environments(organizationId: string, projectId: string): Promise<readonly Environment[]> {
    return (
      await this.required(() =>
        this.client.GET(
          '/api/v1/organizations/{organizationId}/projects/{projectId}/environments',
          {
            params: { path: { organizationId, projectId } },
          },
        ),
      )
    ).items;
  }
  environment(
    organizationId: string,
    projectId: string,
    environmentId: string,
  ): Promise<Environment> {
    return this.required(() =>
      this.client.GET(
        '/api/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}',
        { params: { path: { organizationId, projectId, environmentId } } },
      ),
    );
  }
  createEnvironment(
    organizationId: string,
    projectId: string,
    body: Schema<'EnvironmentSettingsDto'>,
    key: string,
  ): Promise<Environment> {
    return this.required(() =>
      this.client.POST('/api/v1/organizations/{organizationId}/projects/{projectId}/environments', {
        body,
        params: { ...this.mutation(key), path: { organizationId, projectId } },
      }),
    );
  }

  /** Headers the generated types require; the browser request filter sets the real values. */
  protected mutation(key: string): {
    header: { Origin: string; 'X-Shipkeep-CSRF': string; 'Idempotency-Key': string };
  } {
    return { header: { Origin: this.origin, 'X-Shipkeep-CSRF': '', 'Idempotency-Key': key } };
  }
  protected async required<T>(call: () => Promise<Result<T>>): Promise<T> {
    const data = await this.execute(call);
    if (data === undefined) throw new IdentityRequestError(503);
    return data;
  }
  protected async execute<T>(call: () => Promise<Result<T>>): Promise<T | undefined> {
    try {
      const result = await call();
      if (!result.response.ok) {
        const seconds = Number(result.response.headers.get('retry-after'));
        throw new IdentityRequestError(
          result.response.status,
          Number.isFinite(seconds) ? Math.max(0, Math.min(3600, Math.ceil(seconds))) : 0,
        );
      }
      return result.data;
    } catch (error: unknown) {
      if (error instanceof IdentityRequestError) throw error;
      throw new IdentityRequestError(0);
    }
  }
}
