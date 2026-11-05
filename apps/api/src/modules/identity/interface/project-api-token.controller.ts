import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Secret } from '@shipkeep/domain';

import { ProjectApiTokenCommands } from '../application/project-api-token-commands';

import {
  ApiTokenPageQueryDto,
  ProjectApiTokenPageDto,
  projectApiTokenDto,
  ProjectTokenPathDto,
  ProjectTokensPathDto,
} from './api-token.dto';
import { IdentityAttemptLimit } from './identity-rate.guard';
import { IdentityReplayInterceptor } from './identity-replay.interceptor';
import { factorInput, ReauthenticateMfaDto } from './mfa.dto';
import { RequireTenant } from './route-access';
import { type IdentityRequest, resourceContext } from './session-http';

const TOKENS = ':organizationId/projects/:projectId/api-tokens';

/** Session-only administration of project-bound tokens by project administrators (M2.3e2). */
@ApiTags('api-tokens')
@ApiCookieAuth('session')
@Controller('organizations')
@UseInterceptors(IdentityReplayInterceptor)
export class ProjectApiTokenController {
  constructor(private readonly commands: ProjectApiTokenCommands) {}

  @Get(TOKENS)
  @RequireTenant('member.manage', 'project')
  @IdentityAttemptLimit('api')
  @ApiOkResponse({ type: ProjectApiTokenPageDto })
  async listProjectApiTokens(
    @Req() request: IdentityRequest,
    @Param() path: ProjectTokensPathDto,
    @Query() query: ApiTokenPageQueryDto,
  ): Promise<ProjectApiTokenPageDto> {
    const records = await this.commands.list(
      resourceContext(request),
      { organizationId: path.organizationId, projectId: path.projectId },
      query.cursor,
    );
    const items = records.slice(0, query.limit).map(projectApiTokenDto);
    return { items, nextCursor: items.length === query.limit ? (items.at(-1)?.id ?? null) : null };
  }

  @Post(`${TOKENS}/:id/revoke`)
  @HttpCode(204)
  @RequireTenant('member.manage', 'project')
  @IdentityAttemptLimit('token')
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-Shipkeep-CSRF', required: true })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Lowercase UUIDv4/v7; credential-bound encrypted result for five minutes.',
  })
  @ApiNoContentResponse()
  async revokeProjectApiToken(
    @Req() request: IdentityRequest,
    @Param() path: ProjectTokenPathDto,
    @Body() body: ReauthenticateMfaDto,
  ): Promise<void> {
    await this.commands.revoke(
      resourceContext(request),
      { organizationId: path.organizationId, projectId: path.projectId },
      path.id,
      new Secret(body.password),
      factorInput(body),
    );
  }
}
