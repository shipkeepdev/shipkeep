import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

import { IdentityReplayInterceptor } from '../../identity/interface/identity-replay.interceptor';

/** Nest constructs controller interceptors in this module. Delegate to the exported identity
 * instance so its private storage/authentication dependencies stay inside IdentityModule.
 */
@Injectable()
export class ResourceReplayInterceptor implements NestInterceptor {
  constructor(private readonly identity: IdentityReplayInterceptor) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    return this.identity.intercept(context, next);
  }
}
