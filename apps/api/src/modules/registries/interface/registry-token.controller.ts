import {
  Controller,
  Get,
  Header,
  Headers,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { AllowAnonymous } from '../../../platform/http/allow-anonymous';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RegistryTokenRefused, RegistryTokens } from '../application/registry-tokens';
import { basicCredentials } from '../domain/registry-token';

class RegistryTokenDto {
  @ApiProperty({ description: 'A JWT for the registry, signed by the control plane.' })
  token!: string;
  @ApiProperty({ description: 'The same token, as OAuth 2 clients read it.' })
  access_token!: string;
  @ApiProperty({ description: 'Seconds the token lasts: 300 at most.' })
  expires_in!: number;
  @ApiProperty({ format: 'date-time' })
  issued_at!: string;
}

/**
 * The token endpoint of the installation's registry (ADR 0030), which Distribution names in its
 * `Bearer realm`. The Docker daemon and BuildKit call it, not a browser: no session, only the
 * user name and password of a grant an action carries, in a basic authorization header.
 */
@ApiTags('registries')
@Controller('registry')
export class RegistryTokenController {
  constructor(private readonly tokens: RegistryTokens) {}

  @Get('token')
  @AllowAnonymous()
  @IdentityAttemptLimit('api')
  @Header('cache-control', 'no-store')
  @ApiOkResponse({ type: RegistryTokenDto })
  @ApiUnauthorizedResponse({ description: 'Refused, whatever the reason.' })
  async token(
    @Res({ passthrough: true }) response: Response,
    @Headers('authorization') authorization?: unknown,
    @Query('service') service?: unknown,
    @Query('scope') scope?: unknown,
  ): Promise<RegistryTokenDto> {
    try {
      const answer = await this.tokens.token(
        basicCredentials(typeof authorization === 'string' ? authorization : undefined),
        {
          service: typeof service === 'string' ? service : undefined,
          scopes: (Array.isArray(scope) ? scope : [scope]).filter(
            (value): value is string => typeof value === 'string',
          ),
        },
      );
      return {
        token: answer.token,
        access_token: answer.token,
        expires_in: answer.expiresIn,
        issued_at: answer.issuedAt.toISOString(),
      };
    } catch (error: unknown) {
      if (!(error instanceof RegistryTokenRefused)) throw error;
      response.setHeader('www-authenticate', 'Basic realm="Shipkeep registry"');
      throw new UnauthorizedException();
    }
  }
}
