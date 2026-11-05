import { Body, Controller, Param, Req, Res, UseInterceptors } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Secret } from '@shipkeep/domain';
import type { Response } from 'express';

import { AppConfig } from '../../../platform/config/app-config';
import { factorInput } from '../../identity/interface/mfa.dto';
import { AllowAccount } from '../../identity/interface/route-access';
import {
  cookiePolicy,
  type IdentityRequest,
  resourceContext,
  setSessionCookies,
} from '../../identity/interface/session-http';
import { OrganizationCommands } from '../application/organization-commands';

import {
  CreateOrganizationDto,
  OrganizationCreatedDto,
  OrganizationSettingsDto,
} from './organization-mutation.dto';
import { BrowserMutation, ResourceMutation } from './resource-mutation';
import { ResourceReplayInterceptor } from './resource-replay.interceptor';
import { OrganizationDto, OrganizationPathDto, organizationDto } from './resource.dto';

@ApiTags('organizations')
@Controller('organizations')
@UseInterceptors(ResourceReplayInterceptor)
export class OrganizationMutationController {
  constructor(
    private readonly commands: OrganizationCommands,
    private readonly config: AppConfig,
  ) {}

  @BrowserMutation('', 201)
  @AllowAccount()
  @ApiCreatedResponse({ type: OrganizationCreatedDto })
  async createOrganization(
    @Req() request: IdentityRequest,
    @Body() body: CreateOrganizationDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrganizationCreatedDto> {
    const result = await this.commands.create(
      resourceContext(request),
      body,
      new Secret(body.password),
      factorInput(body),
    );
    setSessionCookies(response, result.session, cookiePolicy(this.config.get('API_PUBLIC_URL')));
    return {
      organization: organizationDto(result.organization),
      session: {
        userId: result.session.userId,
        email: result.session.email,
        expiresAt: result.session.expiresAt.toISOString(),
      },
    };
  }

  @ResourceMutation(':organizationId/settings', 'organization.update', 'organization')
  @ApiOkResponse({ type: OrganizationDto })
  async updateOrganization(
    @Req() request: IdentityRequest,
    @Param() path: OrganizationPathDto,
    @Body() body: OrganizationSettingsDto,
  ): Promise<OrganizationDto> {
    return organizationDto(
      await this.commands.update(resourceContext(request), path.organizationId, body),
    );
  }
}
