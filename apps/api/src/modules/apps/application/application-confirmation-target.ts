import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { isTenantId } from '@shipkeep/domain';

import { ConfirmationTargets } from '../../confirmations/application/confirmation-targets';
import type {
  ConfirmationTarget,
  ConfirmationTargetResolver,
} from '../../confirmations/application/ports';
import type { ConfirmationRequest } from '../../confirmations/domain/confirmation-token';

import { APPLICATION_STORE, type ApplicationStore } from './ports';

/**
 * `application.delete` confirms against the application's name, and is authorized on the
 * environment the application lives in (SPEC 3.6, issue #256).
 */
@Injectable()
export class ApplicationConfirmationTarget implements ConfirmationTargetResolver, OnModuleInit {
  constructor(
    @Inject(APPLICATION_STORE) private readonly applications: ApplicationStore,
    private readonly targets: ConfirmationTargets,
  ) {}

  onModuleInit(): void {
    this.targets.register('application.delete', this);
  }

  /** Called inside the requester's tenant transaction. */
  async resolve(request: ConfirmationRequest): Promise<ConfirmationTarget | null> {
    if (!isTenantId(request.target)) return null;
    const application = await this.applications.findById(request.organizationId, request.target);
    return application
      ? {
          name: application.name,
          environment: {
            projectId: application.projectId,
            environmentId: application.environmentId,
          },
        }
      : null;
  }
}
