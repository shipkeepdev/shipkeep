import { setTimeout as delay } from 'node:timers/promises';

import { Controller, Get, Headers, HttpStatus, Param, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiHeader,
  ApiOkResponse,
  ApiProduces,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Length, Matches } from 'class-validator';
import { v7 as uuidv7 } from 'uuid';

import { AllowApiToken } from '../../identity/interface/api-token-access';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { EnvironmentEvents, pumpEvents } from '../application/environment-events';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class EventStreamPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) organizationId!: string;
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) projectId!: string;
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) environmentId!: string;
}

@ApiTags('events')
@ApiCookieAuth('session')
@ApiBearerAuth('apiToken')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class EnvironmentEventsController {
  constructor(private readonly events: EnvironmentEvents) {}

  /** Server-sent hints that something changed; reload through the normal API (SPEC 8). */
  @Get(':organizationId/projects/:projectId/environments/:environmentId/events')
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiProduces('text/event-stream')
  @ApiHeader({
    name: 'Last-Event-ID',
    required: false,
    description: 'Resume after this event; browsers send it when they reconnect.',
  })
  @ApiOkResponse({
    description: 'One `change` event per committed audit event of the environment.',
  })
  async environmentEvents(
    @Req() request: IdentityRequest,
    @Res() response: Response,
    @Param() path: EventStreamPathDto,
    @Headers('accept') accept: string | undefined,
    @Headers('last-event-id') lastEventId: string | undefined,
  ): Promise<void> {
    // Only clients that asked for a stream get one, so nothing hangs on it by accident.
    if (!accept?.includes('text/event-stream')) {
      response.status(HttpStatus.NOT_ACCEPTABLE).end();
      return;
    }
    const context = resourceContext(request);
    const after = lastEventId && UUID.test(lastEventId) ? lastEventId : uuidv7();
    await this.events.run(context.userId, async (shutdown) => {
      const left = new AbortController();
      request.on('close', () => {
        left.abort();
      });
      response.status(HttpStatus.OK);
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      // Reverse proxies must not hold events back.
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders();
      await pumpEvents({
        after,
        poll: (cursor) => this.events.poll(context, path, cursor),
        write: (chunk) => response.write(chunk),
        signal: AbortSignal.any([left.signal, shutdown]),
        sleep: (milliseconds, signal) =>
          delay(milliseconds, undefined, { signal }).catch(() => undefined),
        now: () => Date.now(),
      });
      response.end();
    });
  }
}
