import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Secret } from '@shipkeep/domain';

import { AllowApiToken } from '../../identity/interface/api-token-access';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { RegistryCommands } from '../application/registry-commands';

import {
  RegistryCredentialsDto,
  registryCredentialsDto,
  RegistryCredentialsListDto,
  RegistryOrganizationPathDto,
  RegistryPathDto,
  SetRegistryCredentialsDto,
} from './registry.dto';

const REGISTRIES = ':organizationId/registries';

/**
 * Write-only registry credentials (ADR 0019): no route returns a password. Method names are the
 * OpenAPI operation ids, so they are unique across controllers.
 */
@ApiTags('registries')
@ApiCookieAuth('session')
@ApiBearerAuth('apiToken')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class RegistryController {
  constructor(private readonly registries: RegistryCommands) {}

  @Get(REGISTRIES)
  @RequireTenant('organization.update', 'organization')
  @AllowApiToken('organization.update')
  @ApiOkResponse({ type: RegistryCredentialsListDto })
  async listRegistryCredentials(
    @Req() request: IdentityRequest,
    @Param() path: RegistryOrganizationPathDto,
  ): Promise<RegistryCredentialsListDto> {
    const items = await this.registries.list(resourceContext(request), path.organizationId);
    return { items: items.map(registryCredentialsDto) };
  }

  @Post(REGISTRIES)
  @HttpCode(200)
  @RequireTenant('organization.update', 'organization')
  @AllowApiToken('organization.update')
  @ApiOkResponse({ type: RegistryCredentialsDto })
  async setRegistryCredentials(
    @Req() request: IdentityRequest,
    @Param() path: RegistryOrganizationPathDto,
    @Body() body: SetRegistryCredentialsDto,
  ): Promise<RegistryCredentialsDto> {
    return registryCredentialsDto(
      await this.registries.set(resourceContext(request), path.organizationId, {
        server: body.server,
        username: body.username,
        password: new Secret(body.password),
      }),
    );
  }

  @Post(`${REGISTRIES}/:registryId/remove`)
  @HttpCode(204)
  @RequireTenant('organization.update', 'organization')
  @AllowApiToken('organization.update')
  @ApiNoContentResponse()
  async removeRegistryCredentials(
    @Req() request: IdentityRequest,
    @Param() path: RegistryPathDto,
  ): Promise<void> {
    await this.registries.remove(resourceContext(request), path.organizationId, path.registryId);
  }
}
