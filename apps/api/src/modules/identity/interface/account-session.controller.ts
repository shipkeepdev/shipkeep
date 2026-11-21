import { Controller, Get, HttpCode, Param, Post, Req, UseInterceptors } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AccountSessionCommands } from '../application/account-session-commands';
import type { SecurityContext } from '../application/mfa-commands';

import {
  AccountSessionIdDto,
  AccountSessionListDto,
  accountSessionDto,
} from './account-session.dto';
import { IdentityAttemptLimit } from './identity-rate.guard';
import { IdentityReplayInterceptor } from './identity-replay.interceptor';
import { AllowAccount } from './route-access';
import { clientIp, type IdentityRequest, principal } from './session-http';

/**
 * The account's sessions (issue #253): browser sessions only, since a session lists and ends
 * sessions and an API token never does.
 */
@ApiTags('identity')
@ApiCookieAuth('session')
@Controller('auth/sessions')
@UseInterceptors(IdentityReplayInterceptor)
@AllowAccount()
export class AccountSessionController {
  constructor(private readonly sessions: AccountSessionCommands) {}

  @Get()
  @IdentityAttemptLimit('api')
  @ApiOkResponse({ type: AccountSessionListDto })
  async listSessions(@Req() request: IdentityRequest): Promise<AccountSessionListDto> {
    const items = await this.sessions.list(context(request), principal(request).sessionId);
    return { items: items.map(accountSessionDto) };
  }

  /** Ends another session of the account; it then answers 401. Sign out to end this one. */
  @Post(':sessionId/revoke')
  // An authenticated action, not a credential proof: the account's API quota, without the
  // progressive delay of the proof limits.
  @IdentityAttemptLimit('api')
  @HttpCode(204)
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-Shipkeep-CSRF', required: true })
  @ApiNoContentResponse()
  async revokeSession(
    @Req() request: IdentityRequest,
    @Param() path: AccountSessionIdDto,
  ): Promise<void> {
    await this.sessions.revoke(context(request), principal(request).sessionId, path.sessionId);
  }
}

function context(request: IdentityRequest): SecurityContext {
  const user = principal(request);
  return {
    userId: user.userId,
    securityVersion: user.securityVersion,
    ip: clientIp(request),
    userAgent: request.headers['user-agent'] ?? '',
  };
}
