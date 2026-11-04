import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Secret } from '@shipkeep/domain';
import type { Response } from 'express';

import { AppConfig } from '../../../platform/config/app-config';
import { AccountCommands } from '../application/account-commands';
import { IDENTITY_THROTTLE, type IdentityThrottle } from '../application/identity-throttle';
import { SessionCommands } from '../application/session-commands';
import { AuthenticationError, normalizeEmail } from '../domain/identity-policy';

import {
  CredentialsDto,
  EmailCodeDto,
  EmailDto,
  ResetPasswordDto,
  SessionDto,
} from './identity.dto';
import { AllowAnonymous } from './identity.guard';
import { IdentityAttemptLimit } from './identity-rate.guard';
import { IdentityReplayInterceptor } from './identity-replay.interceptor';
import { factorInput, LoginCredentialsDto } from './mfa.dto';
import {
  clearSessionCookies,
  clientIp,
  cookiePolicy,
  headerCredential,
  type IdentityRequest,
  principal,
  readCredential,
  setSessionCookies,
} from './session-http';

@ApiTags('identity')
@ApiHeader({
  name: 'Origin',
  description: 'Exact API_PUBLIC_URL origin; required for browser mutations.',
  required: false,
})
@Controller('auth')
@UseInterceptors(IdentityReplayInterceptor)
export class IdentityController {
  constructor(
    private readonly accounts: AccountCommands,
    private readonly sessions: SessionCommands,
    private readonly config: AppConfig,
    @Inject(IDENTITY_THROTTLE) private readonly throttle: IdentityThrottle,
  ) {}

  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Lowercase UUIDv4/v7. Reuses the same request result for five minutes.',
  })
  @Post('register')
  @HttpCode(202)
  @AllowAnonymous()
  @IdentityAttemptLimit('register')
  @ApiResponse({
    status: 202,
    description: 'Accepted. Existing accounts receive the same response.',
  })
  async register(@Body() body: CredentialsDto): Promise<void> {
    this.requireMail();
    await this.accounts.register(body.email, new Secret(body.password));
  }

  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Lowercase UUIDv4/v7. Reuses the same request result for five minutes.',
  })
  @Post('verification/request')
  @HttpCode(202)
  @AllowAnonymous()
  @IdentityAttemptLimit('email')
  @ApiResponse({ status: 202, description: 'Accepted regardless of account existence or status.' })
  async requestVerification(@Body() body: EmailDto): Promise<void> {
    this.requireMail();
    await this.accounts.requestEmail(body.email, 'verify');
  }

  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Lowercase UUIDv4/v7. Reuses the same request result for five minutes.',
  })
  @Post('verify')
  @HttpCode(204)
  @AllowAnonymous()
  @IdentityAttemptLimit('verify')
  @ApiNoContentResponse()
  async verifyEmail(@Body() body: EmailCodeDto): Promise<void> {
    await this.accounts.verifyEmail(new Secret(body.token));
  }

  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Lowercase UUIDv4/v7. Reuses the same request result for five minutes.',
  })
  @Post('reset/request')
  @HttpCode(202)
  @AllowAnonymous()
  @IdentityAttemptLimit('email')
  @ApiResponse({ status: 202, description: 'Accepted regardless of account existence or status.' })
  async requestPasswordReset(@Body() body: EmailDto): Promise<void> {
    this.requireMail();
    await this.accounts.requestEmail(body.email, 'reset');
  }

  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Lowercase UUIDv4/v7. Reuses the same request result for five minutes.',
  })
  @Post('reset')
  @HttpCode(204)
  @AllowAnonymous()
  @IdentityAttemptLimit('reset')
  @ApiNoContentResponse()
  async resetPassword(@Body() body: ResetPasswordDto): Promise<void> {
    await this.accounts.resetPassword(new Secret(body.token), new Secret(body.password));
  }

  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Lowercase UUIDv4/v7. Reuses the same request result for five minutes.',
  })
  @Post('login')
  @HttpCode(200)
  @AllowAnonymous()
  @IdentityAttemptLimit('login')
  @ApiOkResponse({ type: SessionDto })
  async login(
    @Body() body: LoginCredentialsDto,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    const policy = cookiePolicy(this.config.get('API_PUBLIC_URL'));
    // Only a presented session cookie participates in rotation; unrelated cookies are ignored.
    const hasSession = request.headers.cookie
      ?.split(';')
      .some((value) => value.trim().startsWith(`${policy.name}=`));
    const grant = await this.sessions.login({
      email: body.email,
      password: new Secret(body.password),
      secondFactor: factorInput(body),
      ip: clientIp(request),
      userAgent: request.headers['user-agent'] ?? '',
      ...(hasSession ? { previous: readCredential(request.headers.cookie, policy.name) } : {}),
    });
    await this.throttle.succeeded(normalizeEmail(body.email));
    setSessionCookies(response, grant, policy);
    return { userId: grant.userId, email: grant.email, expiresAt: grant.expiresAt.toISOString() };
  }

  @Get('session')
  @ApiCookieAuth('session')
  @ApiOkResponse({ type: SessionDto })
  session(@Req() request: IdentityRequest): SessionDto {
    const user = principal(request);
    return { userId: user.userId, email: user.email, expiresAt: user.expiresAt.toISOString() };
  }

  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Lowercase UUIDv4/v7. Reuses the same request result for five minutes.',
  })
  @Post('logout')
  @AllowAnonymous()
  @IdentityAttemptLimit('token')
  @HttpCode(204)
  @ApiCookieAuth('session')
  @ApiNoContentResponse()
  @ApiHeader({
    name: 'X-Shipkeep-CSRF',
    required: true,
    description: 'CSRF cookie value bound to this session.',
  })
  async logout(
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    // Authentication stays inside this handler so a committed logout can be replayed even
    // after revocation. The interceptor requires the same session and CSRF proof on retries.
    if (request.headers.authorization !== undefined) throw new AuthenticationError();
    const token = readCredential(
      request.headers.cookie,
      cookiePolicy(this.config.get('API_PUBLIC_URL')).name,
    );
    const { user } = await this.sessions.authenticate(
      token,
      headerCredential(request.headers['x-shipkeep-csrf']),
    );
    await this.sessions.logout(user.id, token);
    clearSessionCookies(response, cookiePolicy(this.config.get('API_PUBLIC_URL')));
  }

  private requireMail(): void {
    if (!this.config.get('SMTP_HOST'))
      throw new ServiceUnavailableException('Email delivery temporarily unavailable.');
  }
}
