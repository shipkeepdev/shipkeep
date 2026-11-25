import { Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { AllowSignedBody } from '../../../platform/http/allow-anonymous';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { GithubWebhooks } from '../application/github-webhooks';
import { WebhookRejected } from '../domain/github-webhook';

import { GitOrganizationPathDto } from './github-app.dto';

/**
 * Where GitHub delivers the webhooks of an organization's App (ADR 0031). No session or token: the
 * signature over the raw body, with the App's webhook secret, is the authentication. The body
 * arrives unparsed (bootstrap's webhook parser), at most 1 MiB.
 */
@ApiTags('git')
@Controller('webhooks')
export class GithubWebhookController {
  constructor(private readonly webhooks: GithubWebhooks) {}

  @Post('github/:organizationId')
  @HttpCode(204)
  @AllowSignedBody()
  @IdentityAttemptLimit('api')
  @ApiNoContentResponse({ description: 'Accepted, or already received.' })
  async receiveGithubWebhook(
    @Req() request: Request,
    @Param() path: GitOrganizationPathDto,
    @Headers('x-github-event') event?: string,
    @Headers('x-github-delivery') delivery?: string,
    @Headers('x-hub-signature-256') signature?: string,
  ): Promise<void> {
    const body: unknown = request.body;
    if (!Buffer.isBuffer(body)) throw new WebhookRejected();
    await this.webhooks.receive(path.organizationId, { event, delivery, signature }, body);
  }
}
