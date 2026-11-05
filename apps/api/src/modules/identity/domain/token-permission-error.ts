import { DomainError } from '@shipkeep/domain';

export class TokenPermissionError extends DomainError {
  readonly kind = 'forbidden' as const;
  readonly code = 'api_token_permission_denied';
  constructor() {
    super('Permission denied.');
  }
}
