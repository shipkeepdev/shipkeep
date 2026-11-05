import {
  applyDecorators,
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Secret } from '@shipkeep/domain';
import type { Response } from 'express';

import { AppConfig } from '../../../platform/config/app-config';
import type { PrivilegeChangeResult } from '../../identity/application/account-mutation-authority';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { factorInput } from '../../identity/interface/mfa.dto';
import { RequireTenant } from '../../identity/interface/route-access';
import {
  cookiePolicy,
  type IdentityRequest,
  resourceContext,
  setSessionCookies,
} from '../../identity/interface/session-http';
import { MembershipCommands } from '../application/membership-commands';
import type { MembershipRecord } from '../application/membership-store';

import { membershipDto } from './administration.dto';
import {
  AddMemberDto,
  MemberRoleDto,
  MembershipMutationDto,
  MembershipPathDto,
  RemoveMemberDto,
} from './membership-mutation.dto';
import { BrowserHeaders } from './resource-mutation';
import { ResourceReplayInterceptor } from './resource-replay.interceptor';
import { OrganizationPathDto } from './resource.dto';

/** Session-only: membership changes need a fresh password and the configured second factor. */
function MemberMutation(path: string, status = 200): MethodDecorator {
  return applyDecorators(
    Post(path),
    HttpCode(status),
    RequireTenant('member.manage', 'organization'),
    IdentityAttemptLimit('token'),
    BrowserHeaders(),
  );
}

@ApiTags('organizations')
@Controller('organizations')
@UseInterceptors(ResourceReplayInterceptor)
export class MembershipMutationController {
  constructor(
    private readonly commands: MembershipCommands,
    private readonly config: AppConfig,
  ) {}

  @MemberMutation(':organizationId/members', 201)
  @ApiCreatedResponse({ type: MembershipMutationDto })
  async add(
    @Req() request: IdentityRequest,
    @Param() path: OrganizationPathDto,
    @Body() body: AddMemberDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MembershipMutationDto> {
    const result = await this.commands.add(
      resourceContext(request),
      path.organizationId,
      body.email,
      body.role,
      new Secret(body.password),
      factorInput(body),
    );
    return this.respond(result, response);
  }

  @MemberMutation(':organizationId/members/:membershipId/role')
  @ApiOkResponse({ type: MembershipMutationDto })
  async setRole(
    @Req() request: IdentityRequest,
    @Param() path: MembershipPathDto,
    @Body() body: MemberRoleDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MembershipMutationDto> {
    const result = await this.commands.setRole(
      resourceContext(request),
      path.organizationId,
      path.membershipId,
      body.role,
      new Secret(body.password),
      factorInput(body),
    );
    return this.respond(result, response);
  }

  @MemberMutation(':organizationId/members/:membershipId/remove')
  @ApiOkResponse({ type: MembershipMutationDto })
  async remove(
    @Req() request: IdentityRequest,
    @Param() path: MembershipPathDto,
    @Body() body: RemoveMemberDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MembershipMutationDto> {
    const result = await this.commands.remove(
      resourceContext(request),
      path.organizationId,
      path.membershipId,
      new Secret(body.password),
      factorInput(body),
    );
    return this.respond(result, response);
  }

  private respond(
    result: PrivilegeChangeResult<MembershipRecord | null>,
    response: Response,
  ): MembershipMutationDto {
    const membership = result.value ? membershipDto(result.value) : null;
    if (!result.session) return { membership };
    setSessionCookies(response, result.session, cookiePolicy(this.config.get('API_PUBLIC_URL')));
    return {
      membership,
      session: {
        userId: result.session.userId,
        email: result.session.email,
        expiresAt: result.session.expiresAt.toISOString(),
      },
    };
  }
}
