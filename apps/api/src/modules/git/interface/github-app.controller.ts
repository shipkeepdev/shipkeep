import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AllowApiToken } from '../../identity/interface/api-token-access';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { GithubAppCommands } from '../application/github-app-commands';

import {
  CompleteGithubAppDto,
  GithubAppCreationDto,
  GithubAppDto,
  githubAppDto,
  GithubAppStatusDto,
  GitOrganizationPathDto,
  StartGithubAppDto,
} from './github-app.dto';

const APP = ':organizationId/github-app';

/**
 * An organization's GitHub App (ADR 0031). Creating it is a browser flow of an owner, so its two
 * steps take a session only, never an API token.
 */
@ApiTags('git')
@ApiCookieAuth('session')
@ApiBearerAuth('apiToken')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class GithubAppController {
  constructor(private readonly apps: GithubAppCommands) {}

  @Get(APP)
  @RequireTenant('organization.read', 'organization')
  @AllowApiToken('organization.read')
  @ApiOkResponse({ type: GithubAppStatusDto })
  async getGithubApp(
    @Req() request: IdentityRequest,
    @Param() path: GitOrganizationPathDto,
  ): Promise<GithubAppStatusDto> {
    const app = await this.apps.find(resourceContext(request), path.organizationId);
    return { app: app ? githubAppDto(app) : null };
  }

  @Post(`${APP}/manifests`)
  @HttpCode(201)
  @RequireTenant('integration.manage', 'organization')
  @ApiCreatedResponse({ type: GithubAppCreationDto })
  startGithubApp(
    @Req() request: IdentityRequest,
    @Param() path: GitOrganizationPathDto,
    @Body() body: StartGithubAppDto,
  ): Promise<GithubAppCreationDto> {
    return this.apps.start(resourceContext(request), path.organizationId, {
      githubOrganization: body.owner === 'organization' ? body.githubOrganization : undefined,
    });
  }

  @Post(APP)
  @HttpCode(201)
  @RequireTenant('integration.manage', 'organization')
  @ApiCreatedResponse({ type: GithubAppDto })
  async completeGithubApp(
    @Req() request: IdentityRequest,
    @Param() path: GitOrganizationPathDto,
    @Body() body: CompleteGithubAppDto,
  ): Promise<GithubAppDto> {
    return githubAppDto(
      await this.apps.complete(resourceContext(request), path.organizationId, {
        code: body.code,
        state: body.state,
      }),
    );
  }
}
