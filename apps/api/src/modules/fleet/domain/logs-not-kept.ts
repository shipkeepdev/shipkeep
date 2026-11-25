import { DomainError } from '@shipkeep/domain';

/** Raised when a log batch arrives while the installation keeps no logs (ADR 0029). */
export class LogsNotKeptError extends DomainError {
  readonly kind = 'precondition_failed' as const;
  readonly code = 'logs_not_kept';

  constructor() {
    super('this installation keeps no logs');
  }
}

/**
 * Raised when a node, or this process, has as many log deliveries under way as it may, or a
 * batch would wait past its node's longest quota wait: the agent sends it again later.
 */
export class LogsBusyError extends DomainError {
  readonly kind = 'precondition_failed' as const;
  readonly code = 'logs_busy';

  constructor() {
    super('too many log deliveries under way');
  }
}
