import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

import { IdentityReplayInterceptor } from '../../identity/interface/identity-replay.interceptor';

/**
 * Replays a write retried with the same `Idempotency-Key` (#214): a change written to a repository
 * whose answer was lost is answered again, never written a second time. Nest builds controller
 * interceptors in this module: this one hands over to the identity module's own instance, whose
 * storage stays inside that module.
 */
@Injectable()
export class ApplicationReplayInterceptor implements NestInterceptor {
  constructor(private readonly identity: IdentityReplayInterceptor) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    return this.identity.intercept(context, next);
  }
}
