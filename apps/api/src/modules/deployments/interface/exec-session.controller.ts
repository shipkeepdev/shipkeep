import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';

import { ApplicationPathDto } from '../../apps/interface/application.dto';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { ExecSessions } from '../application/exec-sessions';

import { ExecSessionDto, execSessionDto, OpenExecSessionDto } from './exec-session.dto';

const APPLICATION =
  ':organizationId/projects/:projectId/environments/:environmentId/applications/:applicationId';

/**
 * Interactive sessions in an application's containers (SPEC 3.1, M6.1). A browser session opens
 * them; API tokens cannot, until a client of their own joins sessions.
 */
@ApiTags('deployments')
@ApiCookieAuth('session')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class ExecSessionController {
  constructor(private readonly sessions: ExecSessions) {}

  /** Opens a session; the caller then joins it on its WebSocket path within a minute. */
  @Post(`${APPLICATION}/exec-sessions`)
  @HttpCode(201)
  @RequireTenant('container.exec', 'environment')
  @ApiCreatedResponse({ type: ExecSessionDto })
  async open(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
    @Body() body: OpenExecSessionDto,
  ): Promise<ExecSessionDto> {
    const { organizationId, projectId, environmentId } = path;
    return execSessionDto(
      await this.sessions.open(
        resourceContext(request),
        { organizationId, projectId, environmentId },
        path.applicationId,
        body,
      ),
    );
  }
}
