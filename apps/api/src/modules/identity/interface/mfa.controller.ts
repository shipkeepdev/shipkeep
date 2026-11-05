import {
  applyDecorators,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Secret } from '@shipkeep/domain';
import type { Response } from 'express';

import { AppConfig } from '../../../platform/config/app-config';
import { MfaCommands, type RecoveryGrant, type SecurityContext } from '../application/mfa-commands';
import { MfaQuery } from '../application/mfa-query';
import type { SessionGrant } from '../application/session-commands';

import { SessionDto } from './identity.dto';
import { IdentityAttemptLimit } from './identity-rate.guard';
import { IdentityReplayInterceptor } from './identity-replay.interceptor';
import { AllowAccount } from './route-access';
import {
  EnableMfaDto,
  factorInput,
  MfaPasswordDto,
  MfaRecoveryDto,
  MfaSetupDto,
  MfaStatusDto,
  ReauthenticateMfaDto,
} from './mfa.dto';
import {
  clientIp,
  cookiePolicy,
  type IdentityRequest,
  principal,
  setSessionCookies,
} from './session-http';

function SecurityMutation(path: string): MethodDecorator {
  return applyDecorators(
    Post(path),
    HttpCode(200),
    IdentityAttemptLimit('mfa'),
    ApiHeader({ name: 'Origin', required: true }),
    ApiHeader({ name: 'X-Shipkeep-CSRF', required: true }),
    ApiHeader({
      name: 'Idempotency-Key',
      required: false,
      description: 'Lowercase UUIDv4/v7; bound to the current account security version.',
    }),
  );
}

@ApiTags('identity')
@ApiCookieAuth('session')
@Controller('auth/mfa')
@UseInterceptors(IdentityReplayInterceptor)
@AllowAccount()
export class MfaController {
  constructor(
    private readonly commands: MfaCommands,
    private readonly query: MfaQuery,
    private readonly config: AppConfig,
  ) {}

  @Get()
  @ApiOkResponse({ type: MfaStatusDto })
  status(@Req() request: IdentityRequest): Promise<MfaStatusDto> {
    return this.query.status(principal(request));
  }

  @SecurityMutation('setup')
  @ApiOkResponse({ type: MfaSetupDto })
  async setup(@Body() body: MfaPasswordDto, @Req() request: IdentityRequest): Promise<MfaSetupDto> {
    const result = await this.commands.setup(context(request), new Secret(body.password));
    return {
      secret: result.secret.expose(),
      provisioningUri: result.uri.expose(),
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  @SecurityMutation('enable')
  @ApiOkResponse({ type: MfaRecoveryDto })
  async enable(
    @Body() body: EnableMfaDto,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MfaRecoveryDto> {
    return this.recovery(
      response,
      await this.commands.enable(
        context(request),
        new Secret(body.password),
        new Secret(body.totp),
      ),
    );
  }

  @SecurityMutation('disable')
  @ApiOkResponse({ type: SessionDto })
  async disable(
    @Body() body: ReauthenticateMfaDto,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    return this.session(
      response,
      await this.commands.disable(context(request), new Secret(body.password), factorInput(body)),
    );
  }

  @SecurityMutation('recovery')
  @ApiOkResponse({ type: MfaRecoveryDto })
  async regenerateRecovery(
    @Body() body: ReauthenticateMfaDto,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MfaRecoveryDto> {
    return this.recovery(
      response,
      await this.commands.regenerateRecovery(
        context(request),
        new Secret(body.password),
        factorInput(body),
      ),
    );
  }

  private recovery(response: Response, result: RecoveryGrant): MfaRecoveryDto {
    const session = this.session(response, result.session);
    return {
      userId: session.userId,
      email: session.email,
      expiresAt: session.expiresAt,
      recoveryCodes: result.recoveryCodes.map((code) => code.expose()),
    };
  }
  private session(response: Response, grant: SessionGrant): SessionDto {
    setSessionCookies(response, grant, cookiePolicy(this.config.get('API_PUBLIC_URL')));
    return { userId: grant.userId, email: grant.email, expiresAt: grant.expiresAt.toISOString() };
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
