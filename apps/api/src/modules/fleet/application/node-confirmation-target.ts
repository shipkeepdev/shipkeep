import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { isTenantId } from '@shipkeep/domain';

import { ConfirmationTargets } from '../../confirmations/application/confirmation-targets';
import type {
  ConfirmationTarget,
  ConfirmationTargetResolver,
} from '../../confirmations/application/ports';
import type { ConfirmationRequest } from '../../confirmations/domain/confirmation-token';

import { NODE_STORE, type NodeStore } from './ports';

/** `node.remove` confirms against the node's current name (M2.5a2, M2.7b). */
@Injectable()
export class NodeConfirmationTarget implements ConfirmationTargetResolver, OnModuleInit {
  constructor(
    @Inject(NODE_STORE) private readonly nodes: NodeStore,
    private readonly targets: ConfirmationTargets,
  ) {}

  onModuleInit(): void {
    this.targets.register('node.remove', this);
  }

  /** Called inside the requester's tenant transaction. */
  async resolve(request: ConfirmationRequest): Promise<ConfirmationTarget | null> {
    if (!isTenantId(request.target)) return null;
    const node = await this.nodes.findById(request.organizationId, request.target);
    return node && node.status !== 'removed' ? { name: node.name } : null;
  }
}
