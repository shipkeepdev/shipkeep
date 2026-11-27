import { BadRequestException, Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { ApplicationPathDto } from '../../apps/interface/application.dto';
import { DeploymentPathDto } from '../../deployments/interface/deployment.dto';
import { AllowApiToken } from '../../identity/interface/api-token-access';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { LogsQueries } from '../application/logs-queries';
import { MAX_LOG_RESULTS } from '../domain/logs';

import {
  BuildOutputDto,
  buildOutputDto,
  BuildOutputQueryDto,
  LogsDto,
  logsDto,
  LogsQueryDto,
} from './logs.dto';

/** The longest period one search covers: the retention. */
const MAX_PERIOD_MS = 30 * 86_400_000;

/** An application's logs (ADR 0029). The live view searches again from its last line's time. */
@ApiTags('observability')
@ApiCookieAuth('session')
@ApiBearerAuth('apiToken')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class LogsController {
  constructor(private readonly logs: LogsQueries) {}

  @Get(
    ':organizationId/projects/:projectId/environments/:environmentId/applications/:applicationId/logs',
  )
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiOkResponse({ type: LogsDto })
  async applicationLogs(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
    @Query() query: LogsQueryDto,
  ): Promise<LogsDto> {
    const { applicationId, ...target } = path;
    const { from, to } = logsPeriod(query);
    return logsDto(
      await this.logs.search(resourceContext(request), target, applicationId, {
        text: query.text ?? '',
        stream: query.stream,
        instance: query.instance,
        from,
        fromExact: query.from,
        to,
        limit: query.limit ?? 200,
        order: query.order,
      }),
    );
  }

  /** One deployment's build output (ADR 0032), oldest first, read live while the build runs. */
  @Get(
    ':organizationId/projects/:projectId/environments/:environmentId/applications/:applicationId/deployments/:deploymentId/build-output',
  )
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiOkResponse({ type: BuildOutputDto })
  async buildOutput(
    @Req() request: IdentityRequest,
    @Param() path: DeploymentPathDto,
    @Query() query: BuildOutputQueryDto,
  ): Promise<BuildOutputDto> {
    const { applicationId, deploymentId, ...target } = path;
    const to = new Date();
    const from = query.from ? new Date(query.from) : undefined;
    if (from && !(from.getTime() < to.getTime()))
      throw new BadRequestException('from must be in the past.');
    return buildOutputDto(
      await this.logs.buildOutput(resourceContext(request), target, applicationId, deploymentId, {
        from,
        fromExact: query.from,
        to,
        limit: query.limit ?? MAX_LOG_RESULTS,
      }),
    );
  }
}

/** The period a search covers: the last hour by default, 30 days at most. */
export function logsPeriod(
  query: { readonly from?: string | undefined; readonly to?: string | undefined },
  now = new Date(),
): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 3_600_000);
  if (!(from.getTime() < to.getTime()) || to.getTime() - from.getTime() > MAX_PERIOD_MS)
    throw new BadRequestException(
      'The period must start before it ends, and last 30 days at most.',
    );
  return { from, to };
}
