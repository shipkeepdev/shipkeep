import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { ProfileCommands } from '../application/profile-commands';

import { DisplayNameDto, SessionDto, sessionDto } from './identity.dto';
import { IdentityAttemptLimit } from './identity-rate.guard';
import { AllowAccount } from './route-access';
import { clientIp, type IdentityRequest, principal } from './session-http';

/** The account's own profile (issue #251). Browser sessions only. */
@ApiTags('identity')
@ApiCookieAuth('session')
@Controller('auth/profile')
@AllowAccount()
export class ProfileController {
  constructor(private readonly profiles: ProfileCommands) {}

  /** Sets or removes the name the account shows; answers the session with it. */
  @Post()
  @HttpCode(200)
  @IdentityAttemptLimit('api')
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-Shipkeep-CSRF', required: true })
  @ApiOkResponse({ type: SessionDto })
  async setDisplayName(
    @Req() request: IdentityRequest,
    @Body() body: DisplayNameDto,
  ): Promise<SessionDto> {
    const user = principal(request);
    const name = await this.profiles.setDisplayName(
      {
        userId: user.userId,
        securityVersion: user.securityVersion,
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? '',
      },
      body.displayName,
    );
    return sessionDto({ ...user, displayName: name });
  }
}
