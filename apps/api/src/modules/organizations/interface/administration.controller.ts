import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { AdministrationQueries } from '../application/administration-queries';

import { BindingPageDto, MemberPageDto } from './administration.dto';
import {
  CatalogQueryDto,
  EnvironmentPathDto,
  OrganizationPathDto,
  ProjectPathDto,
  resourceDto,
} from './resource.dto';

@ApiTags('organizations')
@ApiCookieAuth('session')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class AdministrationController {
  constructor(private readonly queries: AdministrationQueries) {}

  @Get(':organizationId/members')
  @RequireTenant('member.manage', 'organization')
  @ApiOkResponse({ type: MemberPageDto })
  async members(
    @Req() request: IdentityRequest,
    @Param() path: OrganizationPathDto,
    @Query() query: CatalogQueryDto,
  ): Promise<MemberPageDto> {
    const page = await this.queries.members(resourceContext(request), path.organizationId, query);
    return { ...page, items: page.items.map(resourceDto) };
  }

  @Get(':organizationId/projects/:projectId/bindings')
  @RequireTenant('member.manage', 'project')
  @ApiOkResponse({ type: BindingPageDto })
  async projectBindings(
    @Req() request: IdentityRequest,
    @Param() path: ProjectPathDto,
    @Query() query: CatalogQueryDto,
  ): Promise<BindingPageDto> {
    const page = await this.queries.bindings(resourceContext(request), path, query);
    return { ...page, items: page.items.map(resourceDto) };
  }

  @Get(':organizationId/projects/:projectId/environments/:environmentId/bindings')
  @RequireTenant('member.manage', 'environment')
  @ApiOkResponse({ type: BindingPageDto })
  async environmentBindings(
    @Req() request: IdentityRequest,
    @Param() path: EnvironmentPathDto,
    @Query() query: CatalogQueryDto,
  ): Promise<BindingPageDto> {
    const page = await this.queries.bindings(resourceContext(request), path, query);
    return { ...page, items: page.items.map(resourceDto) };
  }
}
