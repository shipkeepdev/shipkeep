import { applyDecorators, Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
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

/** OpenAPI headers of a session-only mutation: its exact Origin and its CSRF proof. */
function SessionHeaders(): MethodDecorator {
  return applyDecorators(
    ApiHeader({ name: 'Origin', required: true, description: 'Exact API origin.' }),
    ApiHeader({
      name: 'X-Shipkeep-CSRF',
      required: true,
      description: 'Session-bound CSRF proof.',
    }),
  );
}

/**
 * An organization's GitHub App (ADR 0031). Creating it is a browser flow of an owner, so its two
 * steps take a session only, never an API token.
 */
@ApiTags('git')
@ApiCookieAuth('session')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class GithubAppController {
  constructor(private readonly apps: GithubAppCommands) {}

  @Get(APP)
  @RequireTenant('organization.read', 'organization')
  @AllowApiToken('organization.read')
  @ApiBearerAuth('apiToken')
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
  @SessionHeaders()
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
  @SessionHeaders()
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
