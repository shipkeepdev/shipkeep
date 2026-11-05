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
import { SecretCommands } from '../application/secret-commands';
import type { SecretTarget } from '../domain/secret-policy';

import {
  SecretDto,
  secretDto,
  SecretEnvironmentPathDto,
  SecretListDto,
  SecretPathDto,
  SetSecretDto,
} from './secret.dto';

const SECRETS = ':organizationId/projects/:projectId/environments/:environmentId/secrets';

/** Write-only secrets: no route returns a value, and writes have no encrypted retry. */
@ApiTags('secrets')
@ApiCookieAuth('session')
@ApiBearerAuth('apiToken')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class SecretController {
  constructor(private readonly secrets: SecretCommands) {}

  @Get(SECRETS)
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiOkResponse({ type: SecretListDto })
  async listSecrets(
    @Req() request: IdentityRequest,
    @Param() path: SecretEnvironmentPathDto,
  ): Promise<SecretListDto> {
    return {
      items: (await this.secrets.list(resourceContext(request), target(path))).map(secretDto),
    };
  }

  @Post(SECRETS)
  @HttpCode(200)
  @RequireTenant('secret.write', 'environment')
  @AllowApiToken('secret.write')
  @ApiOkResponse({ type: SecretDto })
  async setSecret(
    @Req() request: IdentityRequest,
    @Param() path: SecretEnvironmentPathDto,
    @Body() body: SetSecretDto,
  ): Promise<SecretDto> {
    return secretDto(
      await this.secrets.set(
        resourceContext(request),
        target(path),
        body.name,
        new Secret(body.value),
      ),
    );
  }

  @Post(`${SECRETS}/:name/remove`)
  @HttpCode(204)
  @RequireTenant('secret.write', 'environment')
  @AllowApiToken('secret.write')
  @ApiNoContentResponse()
  async removeSecret(@Req() request: IdentityRequest, @Param() path: SecretPathDto): Promise<void> {
    await this.secrets.remove(resourceContext(request), target(path), path.name);
  }
}

function target(path: SecretEnvironmentPathDto): SecretTarget {
  return {
    organizationId: path.organizationId,
    projectId: path.projectId,
    environmentId: path.environmentId,
  };
}
