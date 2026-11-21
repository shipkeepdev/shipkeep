import { Inject, Injectable } from '@nestjs/common';
import { createEvent } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { displayName } from '../domain/display-name';
import { AuthenticationError } from '../domain/identity-policy';

import { IDENTITY_STORE, type IdentityStore } from './identity-store';
import type { SecurityContext } from './mfa-commands';

/**
 * The account's own profile (issue #251): the name it shows instead of its address. The name is
 * never used to sign in, so changing it needs the session alone; each change is audited as
 * `identity.profile_updated`, with the account as actor and no organization.
 */
@Injectable()
export class ProfileCommands {
  constructor(
    @Inject(IDENTITY_STORE) private readonly users: IdentityStore,
    private readonly events: DomainEventBus,
  ) {}

  setDisplayName(
    context: SecurityContext,
    input: string | null,
    now = new Date(),
  ): Promise<string | null> {
    const name = displayName(input);
    return this.users.withUserLock(context.userId, async (user) => {
      if (user.status !== 'active' || user.securityVersion !== context.securityVersion)
        throw new AuthenticationError();
      if ((user.displayName ?? null) === name) return name;
      await this.users.setDisplayName(user.id, name, now);
      await this.events.publish([
        createEvent({
          type: 'identity.profile_updated',
          actor: { kind: 'user', id: context.userId, ip: context.ip },
          target: { type: 'user', id: user.id },
          payload: { displayName: name === null ? 'removed' : 'set' },
          occurredAt: now,
        }),
      ]);
      return name;
    });
  }
}
