import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { createEvent, Secret, SYSTEM_ACTOR } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import {
  applicationRepository,
  grantSecretHash,
  grantUsername,
  REGISTRY_SECRET_BYTES,
} from '../domain/registry-token';

import { REGISTRY_GRANT_STORE, type RegistryGrantStore } from './ports';

/** Expired grants are removed this long after their deadline, when the organization issues one. */
const KEEP_EXPIRED_MS = 86_400_000;

/** What an action carries to reach the registry (`RegistryCredentials` in actions.proto). */
export interface IssuedRegistryGrant {
  readonly username: string;
  /** Sent as the `password` of `RegistryCredentials`. */
  readonly secret: Secret;
  readonly expiresAt: Date;
}

/**
 * Issues the credentials an action uses with the installation's registry (ADR 0030): pull on one
 * application's repository, and push for a build, until the action's own deadline. Only the
 * secret's hash is kept, and the secret goes nowhere but the action. Runs in the caller's
 * tenant transaction, as the system: the deployment that needs it is what the user asked for.
 */
@Injectable()
export class RegistryGrants {
  constructor(
    @Inject(REGISTRY_GRANT_STORE) private readonly store: RegistryGrantStore,
    private readonly events: DomainEventBus,
  ) {}

  async issue(
    application: { readonly organizationId: string; readonly id: string },
    options: { readonly push: boolean; readonly expiresAt: Date },
    now = new Date(),
  ): Promise<IssuedRegistryGrant> {
    if (options.expiresAt.getTime() <= now.getTime())
      throw new Error('a registry grant must expire after it is issued');
    const id = uuidv7();
    const secret = randomBytes(REGISTRY_SECRET_BYTES).toString('base64url');
    await this.store.removeExpired(
      application.organizationId,
      new Date(now.getTime() - KEEP_EXPIRED_MS),
    );
    await this.store.insert({
      id,
      organizationId: application.organizationId,
      applicationId: application.id,
      secretSha256: grantSecretHash(secret),
      push: options.push,
      expiresAt: options.expiresAt,
      createdAt: now,
    });
    await this.events.publish([
      createEvent({
        type: 'registry.grant_issued',
        organizationId: application.organizationId,
        actor: SYSTEM_ACTOR,
        target: { type: 'application', id: application.id },
        payload: {
          grantId: id,
          repository: applicationRepository(application.organizationId, application.id),
          push: options.push,
          expiresAt: options.expiresAt.toISOString(),
        },
        occurredAt: now,
      }),
    ]);
    return {
      username: grantUsername(application.organizationId, id),
      secret: new Secret(secret),
      expiresAt: options.expiresAt,
    };
  }
}
