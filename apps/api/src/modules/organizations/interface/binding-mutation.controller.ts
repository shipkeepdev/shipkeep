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
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Secret } from '@shipkeep/domain';
import type { Response } from 'express';

import { AppConfig } from '../../../platform/config/app-config';
import type { PrivilegeChangeResult } from '../../identity/application/account-mutation-authority';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { factorInput } from '../../identity/interface/mfa.dto';
import { RequireTenant, type TenantScope } from '../../identity/interface/route-access';
import {
  cookiePolicy,
  type IdentityRequest,
  resourceContext,
  setSessionCookies,
} from '../../identity/interface/session-http';
import { BindingCommands } from '../application/binding-commands';
import type { BindingRecord, BindingTarget } from '../application/binding-store';

import {
  AssignBindingDto,
  bindingDto,
  BindingMutationDto,
  EnvironmentBindingPathDto,
  ProjectBindingPathDto,
  RemoveBindingDto,
} from './binding-mutation.dto';
import { BrowserHeaders } from './resource-mutation';
import { ResourceReplayInterceptor } from './resource-replay.interceptor';
import { EnvironmentPathDto, ProjectPathDto } from './resource.dto';

/** Session-only: role bindings change privileges and need a fresh password and second factor. */
function BindingMutation(path: string, scope: TenantScope): MethodDecorator {
  return applyDecorators(
    Post(path),
    HttpCode(200),
    RequireTenant('member.manage', scope),
    IdentityAttemptLimit('token'),
    BrowserHeaders(),
    ApiOkResponse({ type: BindingMutationDto }),
  );
}

const PROJECT = ':organizationId/projects/:projectId/bindings';
const ENVIRONMENT = ':organizationId/projects/:projectId/environments/:environmentId/bindings';

@ApiTags('organizations')
@Controller('organizations')
@UseInterceptors(ResourceReplayInterceptor)
export class BindingMutationController {
  constructor(
    private readonly commands: BindingCommands,
    private readonly config: AppConfig,
  ) {}

  @BindingMutation(PROJECT, 'project')
  assignProject(
    @Req() request: IdentityRequest,
    @Param() path: ProjectPathDto,
    @Body() body: AssignBindingDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BindingMutationDto> {
    return this.assign(request, project(path), body, response);
  }

  @BindingMutation(`${PROJECT}/:membershipId/remove`, 'project')
  removeProject(
    @Req() request: IdentityRequest,
    @Param() path: ProjectBindingPathDto,
    @Body() body: RemoveBindingDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BindingMutationDto> {
    return this.remove(request, project(path), path.membershipId, body, response);
  }

  @BindingMutation(ENVIRONMENT, 'environment')
  assignEnvironment(
    @Req() request: IdentityRequest,
    @Param() path: EnvironmentPathDto,
    @Body() body: AssignBindingDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BindingMutationDto> {
    return this.assign(request, environment(path), body, response);
  }

  @BindingMutation(`${ENVIRONMENT}/:membershipId/remove`, 'environment')
  removeEnvironment(
    @Req() request: IdentityRequest,
    @Param() path: EnvironmentBindingPathDto,
    @Body() body: RemoveBindingDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BindingMutationDto> {
    return this.remove(request, environment(path), path.membershipId, body, response);
  }

  private async assign(
    request: IdentityRequest,
    target: BindingTarget,
    body: AssignBindingDto,
    response: Response,
  ): Promise<BindingMutationDto> {
    const result = await this.commands.assign(
      resourceContext(request),
      target,
      body.email,
      body.role,
      new Secret(body.password),
      factorInput(body),
    );
    return this.respond(result, response);
  }

  private async remove(
    request: IdentityRequest,
    target: BindingTarget,
    membershipId: string,
    body: RemoveBindingDto,
    response: Response,
  ): Promise<BindingMutationDto> {
    const result = await this.commands.remove(
      resourceContext(request),
      target,
      membershipId,
      new Secret(body.password),
      factorInput(body),
    );
    return this.respond(result, response);
  }

  private respond(
    result: PrivilegeChangeResult<BindingRecord | null>,
    response: Response,
  ): BindingMutationDto {
    const binding = result.value ? bindingDto(result.value) : null;
    if (!result.session) return { binding };
    setSessionCookies(response, result.session, cookiePolicy(this.config.get('API_PUBLIC_URL')));
    return {
      binding,
      session: {
        userId: result.session.userId,
        email: result.session.email,
        expiresAt: result.session.expiresAt.toISOString(),
      },
    };
  }
}

/** Only the canonical path ids reach the command; extra path fields are never forwarded. */
function project(path: ProjectPathDto): BindingTarget {
  return { organizationId: path.organizationId, projectId: path.projectId };
}
function environment(path: EnvironmentPathDto): BindingTarget {
  return {
    organizationId: path.organizationId,
    projectId: path.projectId,
    environmentId: path.environmentId,
  };
}
