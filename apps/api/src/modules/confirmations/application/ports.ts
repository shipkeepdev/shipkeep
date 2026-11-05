import type { ConfirmableAction, ConfirmationRequest } from '../domain/confirmation-token';

export interface ConfirmationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly action: ConfirmableAction;
  readonly target: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export const CONFIRMATION_STORE = Symbol('ConfirmationStore');
/** Both methods run inside the caller's tenant transaction (`runTenant`). */
export interface ConfirmationStore {
  insert(record: ConfirmationRecord): Promise<void>;
  /** Marks the token used if it is unused, unexpired and bound to exactly this request and user. */
  consume(id: string, request: ConfirmationRequest, userId: string, now: Date): Promise<boolean>;
}

export const CONFIRMATION_TRANSACTION = Symbol('ConfirmationTransaction');
export interface ConfirmationTransaction {
  runTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T>;
}

/** The current name of a confirmable resource, typed back by the user. */
export interface ConfirmationTarget {
  readonly name: string;
}
/** Implemented by the module that owns the resource; runs in the requester's context. */
export interface ConfirmationTargetResolver {
  resolve(request: ConfirmationRequest): Promise<ConfirmationTarget | null>;
}
export type { ConfirmableAction };
