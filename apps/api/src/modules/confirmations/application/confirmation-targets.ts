import { Injectable } from '@nestjs/common';

import type { ConfirmableAction, ConfirmationRequest } from '../domain/confirmation-token';

import type { ConfirmationTarget, ConfirmationTargetResolver } from './ports';

/**
 * Resolvers for the resources each confirmable action targets. The module owning a resource
 * registers its resolver at startup; an action without one cannot be confirmed.
 */
@Injectable()
export class ConfirmationTargets {
  private readonly resolvers = new Map<ConfirmableAction, ConfirmationTargetResolver>();

  register(action: ConfirmableAction, resolver: ConfirmationTargetResolver): void {
    if (this.resolvers.has(action)) throw new Error(`duplicate confirmation resolver: ${action}`);
    this.resolvers.set(action, resolver);
  }

  async resolve(request: ConfirmationRequest): Promise<ConfirmationTarget | null> {
    return (await this.resolvers.get(request.action)?.resolve(request)) ?? null;
  }
}
