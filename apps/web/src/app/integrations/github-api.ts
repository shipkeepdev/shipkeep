import { Injectable } from '@angular/core';

import { type Schema, WorkspaceApi } from '../workspace/workspace-api';

export type GithubApp = Schema<'GithubAppDto'>;
export type GithubRepository = Schema<'GithubRepositoryDto'>;
export type GithubRepositories = Schema<'GithubRepositoriesDto'>;
export type GithubAppCreation = Schema<'GithubAppCreationDto'>;

/**
 * The organization's GitHub App (ADR 0031): its status, GitHub's manifest flow that creates it,
 * and the repositories its installations reach.
 */
@Injectable({ providedIn: 'root' })
export class GithubApi extends WorkspaceApi {
  /** The App, or null before an owner creates it. */
  async app(organizationId: string): Promise<GithubApp | null> {
    return (
      await this.required(() =>
        this.client.GET('/api/v1/organizations/{organizationId}/github-app', {
          params: { path: { organizationId } },
        }),
      )
    ).app;
  }
  /** The manifest and the GitHub page to post it to; the browser then leaves for GitHub. */
  startManifest(
    organizationId: string,
    body: Schema<'StartGithubAppDto'>,
  ): Promise<GithubAppCreation> {
    return this.required(() =>
      this.client.POST('/api/v1/organizations/{organizationId}/github-app/manifests', {
        body,
        params: { path: { organizationId }, header: this.browser() },
      }),
    );
  }
  /** Stores the App GitHub created, from the code and state it sent back. */
  connect(organizationId: string, body: Schema<'CompleteGithubAppDto'>): Promise<GithubApp> {
    return this.required(() =>
      this.client.POST('/api/v1/organizations/{organizationId}/github-app', {
        body,
        params: { path: { organizationId }, header: this.browser() },
      }),
    );
  }
  repositories(organizationId: string): Promise<GithubRepositories> {
    return this.required(() =>
      this.client.GET('/api/v1/organizations/{organizationId}/github-app/repositories', {
        params: { path: { organizationId } },
      }),
    );
  }
  /** Values the browser request filter replaces; required by the generated types. */
  private browser(): { Origin: string; 'X-Shipkeep-CSRF': string } {
    return { Origin: this.origin, 'X-Shipkeep-CSRF': '' };
  }
}
