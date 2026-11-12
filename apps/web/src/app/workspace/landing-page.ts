import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';

import { IdentityRequestError } from '../identity/identity-api';

import { WorkspaceApi } from './workspace-api';

/** Where signing in leads: straight to the organization when there is only one. */
@Component({
  selector: 'sk-landing-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p role="status" class="text-muted">Loading…</p>`,
})
export class LandingPage {
  private readonly api = inject(WorkspaceApi);
  private readonly router = inject(Router);

  constructor() {
    void this.go();
  }

  private async go(): Promise<void> {
    let target: readonly string[] = ['/orgs'];
    try {
      const organizations = await this.api.organizations();
      const only = organizations.length === 1 ? organizations.at(0) : undefined;
      if (only) target = ['/orgs', only.id];
    } catch (error: unknown) {
      if (error instanceof IdentityRequestError && error.status === 401) target = ['/auth/login'];
    }
    await this.router.navigate(target, { replaceUrl: true });
  }
}
