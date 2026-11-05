import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AllowApiToken } from '../../identity/interface/api-token-access';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { AuditQueries } from '../application/audit-queries';

import {
  auditEventDto,
  AuditEventPageDto,
  auditFilter,
  AuditFilterDto,
  AuditOrganizationPathDto,
  AuditPageQueryDto,
} from './audit.dto';

@ApiTags('audit')
@ApiCookieAuth('session')
@ApiBearerAuth('apiToken')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class AuditController {
  constructor(private readonly queries: AuditQueries) {}

  @Get(':organizationId/audit-events')
  @RequireTenant('audit.read', 'organization')
  @AllowApiToken('audit.read')
  @ApiOkResponse({ type: AuditEventPageDto })
  async auditEvents(
    @Req() request: IdentityRequest,
    @Param() path: AuditOrganizationPathDto,
    @Query() query: AuditPageQueryDto,
  ): Promise<AuditEventPageDto> {
    const events = await this.queries.page(
      resourceContext(request),
      path.organizationId,
      auditFilter(query),
      query.cursor,
      query.limit,
    );
    const items = events.map(auditEventDto);
    return { items, nextCursor: items.length === query.limit ? (items.at(-1)?.id ?? null) : null };
  }

  /** JSON Lines, newest first. `X-Shipkeep-Truncated: true` means older matches remain. */
  @Get(':organizationId/audit-events/export')
  @RequireTenant('audit.read', 'organization')
  @AllowApiToken('audit.read')
  @ApiProduces('application/x-ndjson')
  @ApiOkResponse({ description: 'One AuditEventDto JSON object per line, newest first.' })
  async exportAuditEvents(
    @Req() request: IdentityRequest,
    @Param() path: AuditOrganizationPathDto,
    @Query() query: AuditFilterDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const result = await this.queries.export(
      resourceContext(request),
      path.organizationId,
      auditFilter(query),
    );
    response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-${path.organizationId}.jsonl"`,
    );
    response.setHeader('X-Shipkeep-Truncated', result.truncated ? 'true' : 'false');
    return result.events.map((event) => `${JSON.stringify(auditEventDto(event))}\n`).join('');
  }
}
