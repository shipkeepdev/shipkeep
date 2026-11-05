import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiTags,
} from '@nestjs/swagger';

import { AllowApiToken } from '../../identity/interface/api-token-access';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { ConfirmationCommands } from '../application/confirmation-commands';

import {
  ConfirmationIssuedDto,
  ConfirmationPathDto,
  RequestConfirmationDto,
} from './confirmation.dto';

/**
 * Any member may ask; the command then requires the action's own permission (for a token, also
 * in its scopes). No encrypted retry: a lost response is answered with a new confirmation.
 */
@ApiTags('confirmations')
@ApiCookieAuth('session')
@ApiBearerAuth('apiToken')
@Controller('organizations')
export class ConfirmationController {
  constructor(private readonly commands: ConfirmationCommands) {}

  @Post(':organizationId/confirmations')
  @HttpCode(201)
  @RequireTenant('organization.read', 'organization')
  @AllowApiToken('organization.read')
  @IdentityAttemptLimit('api')
  @ApiHeader({ name: 'Origin', required: false, description: 'Required for session requests.' })
  @ApiHeader({
    name: 'X-Shipkeep-CSRF',
    required: false,
    description: 'Required for session requests.',
  })
  @ApiCreatedResponse({ type: ConfirmationIssuedDto })
  async requestConfirmation(
    @Req() request: IdentityRequest,
    @Param() path: ConfirmationPathDto,
    @Body() body: RequestConfirmationDto,
  ): Promise<ConfirmationIssuedDto> {
    const issued = await this.commands.issue(resourceContext(request), {
      organizationId: path.organizationId,
      action: body.action,
      target: body.target,
      typedName: body.name,
    });
    return {
      id: issued.id,
      token: issued.token.expose(),
      expiresAt: issued.expiresAt.toISOString(),
    };
  }
}
