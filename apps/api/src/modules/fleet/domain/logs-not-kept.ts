import { DomainError } from '@shipkeep/domain';

/** Raised when a log batch arrives while the installation keeps no logs (ADR 0029). */
export class LogsNotKeptError extends DomainError {
  readonly kind = 'precondition_failed' as const;
  readonly code = 'logs_not_kept';

  constructor() {
    super('this installation keeps no logs');
  }
}
