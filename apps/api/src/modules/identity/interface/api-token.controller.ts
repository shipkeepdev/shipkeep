import {
  applyDecorators,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Secret } from '@shipkeep/domain';

import { ApiTokenCommands, type ApiTokenMetadata } from '../application/api-token-commands';
import type { SecurityContext } from '../application/mfa-commands';

import {
  ApiTokenCreatedDto,
  ApiTokenIdDto,
  ApiTokenPageDto,
  ApiTokenPageQueryDto,
  CreateApiTokenDto,
  type ApiTokenDto,
} from './api-token.dto';
import { IdentityAttemptLimit } from './identity-rate.guard';
import { IdentityReplayInterceptor } from './identity-replay.interceptor';
import { AllowAccount } from './route-access';
import { factorInput, ReauthenticateMfaDto } from './mfa.dto';
import { clientIp, type IdentityRequest, principal } from './session-http';

function TokenMutation(path: string): MethodDecorator {
  return applyDecorators(
    Post(path),
    IdentityAttemptLimit('token'),
    ApiHeader({ name: 'Origin', required: true }),
    ApiHeader({ name: 'X-Shipkeep-CSRF', required: true }),
    ApiHeader({
      name: 'Idempotency-Key',
      required: false,
      description: 'Lowercase UUIDv4/v7; credential-bound encrypted result for five minutes.',
    }),
  );
}
@ApiTags('api-tokens')
@ApiCookieAuth('session')
@Controller('api-tokens')
@UseInterceptors(IdentityReplayInterceptor)
@AllowAccount()
export class ApiTokenController {
  constructor(private readonly commands: ApiTokenCommands) {}

  @Get()
  @IdentityAttemptLimit('api')
  @ApiOkResponse({ type: ApiTokenPageDto })
  async listApiTokens(
    @Req() request: IdentityRequest,
    @Query() query: ApiTokenPageQueryDto,
  ): Promise<ApiTokenPageDto> {
    const records = await this.commands.list(context(request), query.cursor);
    const items = records.slice(0, query.limit).map(toDto);
    return { items, nextCursor: items.length === query.limit ? (items.at(-1)?.id ?? null) : null };
  }
  @TokenMutation('')
  @ApiCreatedResponse({ type: ApiTokenCreatedDto })
  async createApiToken(
    @Req() request: IdentityRequest,
    @Body() body: CreateApiTokenDto,
  ): Promise<ApiTokenCreatedDto> {
    // class-transformer creates DTO instances; copy scopes into plain domain values explicitly.
    const scopes = body.scopes.map((scope) => ({
      permission: scope.permission,
      ...(scope.organizationId !== undefined ? { organizationId: scope.organizationId } : {}),
      ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
      ...(scope.environmentId !== undefined ? { environmentId: scope.environmentId } : {}),
    }));
    const result = await this.commands.create(
      context(request),
      { name: body.name, scopes, expiresAt: new Date(body.expiresAt) },
      new Secret(body.password),
      factorInput(body),
    );
    return Object.assign(toDto(result.metadata), { token: result.token.expose() });
  }
  @TokenMutation(':id/revoke')
  @HttpCode(204)
  @ApiNoContentResponse()
  async revokeApiToken(
    @Req() request: IdentityRequest,
    @Param() params: ApiTokenIdDto,
    @Body() body: ReauthenticateMfaDto,
  ): Promise<void> {
    await this.commands.revoke(
      context(request),
      params.id,
      new Secret(body.password),
      factorInput(body),
    );
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
function toDto(record: ApiTokenMetadata): ApiTokenDto {
  return {
    id: record.id,
    name: record.name,
    scopes: record.scopes.map((scope) => ({ ...scope })),
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    revokedAt: record.revokedAt?.toISOString() ?? null,
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
  };
}
