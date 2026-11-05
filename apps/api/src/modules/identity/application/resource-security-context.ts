import type { Actor, Permission, ResourceContext, Secret } from '@shipkeep/domain';

import type { SecurityContext } from './mfa-commands';

/** Constructed by authenticated transports, never from a request body. */
export interface ResourceSecurityContext extends SecurityContext {
  readonly apiCredential?: { readonly id: string; readonly value: Secret };
}

/** Chosen by the command itself; the transport cannot substitute a weaker permission. */
export interface CommandAuthority {
  readonly permission: Permission;
  readonly target: ResourceContext;
}

export function resourceActor(context: ResourceSecurityContext): Actor {
  return {
    kind: context.apiCredential ? 'api_token' : 'user',
    id: context.apiCredential?.id ?? context.userId,
    ip: context.ip,
  };
}
