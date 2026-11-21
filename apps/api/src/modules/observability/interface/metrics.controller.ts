import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { ApplicationPathDto } from '../../apps/interface/application.dto';
import { NodePathDto } from '../../fleet/interface/fleet-administration.dto';
import { AllowApiToken } from '../../identity/interface/api-token-access';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { MetricsQueries } from '../application/metrics-queries';

import {
  ApplicationMetricsDto,
  MetricsRangeQueryDto,
  metricsDto,
  NodeMetricsDto,
} from './metrics.dto';

/** Charts of applications and servers (ADR 0024, SPEC 12). */
@ApiTags('metrics')
@ApiCookieAuth('session')
@ApiBearerAuth('apiToken')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class MetricsController {
  constructor(private readonly metrics: MetricsQueries) {}

  @Get(
    ':organizationId/projects/:projectId/environments/:environmentId/applications/:applicationId/metrics',
  )
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiOkResponse({ type: ApplicationMetricsDto })
  async applicationMetrics(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
    @Query() query: MetricsRangeQueryDto,
  ): Promise<ApplicationMetricsDto> {
    const { applicationId, ...target } = path;
    return metricsDto(
      await this.metrics.application(
        resourceContext(request),
        target,
        applicationId,
        query.range ?? '1h',
      ),
    );
  }

  @Get(':organizationId/nodes/:nodeId/metrics')
  @RequireTenant('node.manage', 'organization')
  @ApiOkResponse({ type: NodeMetricsDto })
  async nodeMetrics(
    @Req() request: IdentityRequest,
    @Param() path: NodePathDto,
    @Query() query: MetricsRangeQueryDto,
  ): Promise<NodeMetricsDto> {
    return metricsDto(
      await this.metrics.node(
        resourceContext(request),
        path.organizationId,
        path.nodeId,
        query.range ?? '1h',
      ),
    );
  }
}
