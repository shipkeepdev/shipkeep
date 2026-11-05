import { HttpException } from '@nestjs/common';
import type { Response } from 'express';

import type { ThrottleDecision } from '../application/identity-throttle';

export function enforceThrottle(response: Response, decision: ThrottleDecision): void {
  response.setHeader('RateLimit-Limit', decision.limit);
  response.setHeader('RateLimit-Remaining', decision.remaining);
  response.setHeader(
    'RateLimit-Reset',
    Math.max(0, Math.ceil((decision.resetAt.getTime() - Date.now()) / 1000)),
  );
  if (!decision.allowed) {
    response.setHeader('Retry-After', decision.retryAfterSeconds);
    throw new HttpException('Rate limit exceeded. Try again later.', 429);
  }
}
