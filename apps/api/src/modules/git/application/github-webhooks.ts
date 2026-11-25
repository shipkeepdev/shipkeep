import { createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { createEvent, InvalidInputError, isTenantId, SYSTEM_ACTOR } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import {
  deliveryHeaders,
  installationChange,
  MAX_WEBHOOK_BYTES,
  pingedApp,
  WebhookRejected,
} from '../domain/github-webhook';

import {
  GIT_TRANSACTION,
  GITHUB_WEBHOOK_STORE,
  type GitTransaction,
  type GithubWebhookStore,
} from './ports';

/** What a delivery did; GitHub gets the same answer for each. */
export type DeliveryOutcome = 'applied' | 'duplicate' | 'ignored';

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** The audit event of each installation change: `github.installation_<…>`. */
const AUDITED = {
  created: 'added',
  deleted: 'removed',
  suspend: 'suspended',
  unsuspend: 'unsuspended',
} as const;

/**
 * Deliveries of an organization's GitHub App (ADR 0031). The signature is checked over the raw
 * body, in constant time, before anything is parsed. A delivery is recorded in the transaction
 * that applies it, so a delivery that failed is not recorded and GitHub's redelivery is processed;
 * one recorded before does nothing.
 */
@Injectable()
export class GithubWebhooks {
  constructor(
    @Inject(GITHUB_WEBHOOK_STORE) private readonly store: GithubWebhookStore,
    @Inject(GIT_TRANSACTION) private readonly transaction: GitTransaction,
    private readonly events: DomainEventBus,
  ) {}

  async receive(
    organizationId: string,
    headers: { event?: string; delivery?: string; signature?: string },
    body: Buffer,
    now = new Date(),
  ): Promise<DeliveryOutcome> {
    if (!isTenantId(organizationId) || body.length > MAX_WEBHOOK_BYTES) throw new WebhookRejected();
    const delivery = deliveryHeaders(headers);
    const app = await this.transaction.runTenant(organizationId, () =>
      this.store.webhookSecret(organizationId),
    );
    // An organization without an App answers as a wrong signature does.
    if (!app) throw new WebhookRejected();
    const expected = createHmac('sha256', app.secret.expose()).update(body).digest();
    const given = Buffer.from(delivery.signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new WebhookRejected();
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new InvalidInputError('github_webhook_invalid', 'This delivery is not JSON.');
    }
    return this.transaction.runTenant(organizationId, async () => {
      if (!(await this.store.recordDelivery(organizationId, delivery, now))) return 'duplicate';
      switch (delivery.event) {
        case 'ping':
          if (pingedApp(payload) !== app.appId) throw new WebhookRejected();
          return 'applied';
        case 'installation':
          return this.installation(organizationId, payload, app.appId, now);
        default:
          // Push events are recorded here and deploy nothing yet (M3.1, next step).
          return 'ignored';
      }
    });
  }

  private async installation(
    organizationId: string,
    payload: unknown,
    appId: number,
    now: Date,
  ): Promise<DeliveryOutcome> {
    const change = installationChange(payload, appId);
    if (!change) return 'ignored';
    if (!(await this.store.applyInstallation(organizationId, change, now))) return 'ignored';
    const sender = (payload as { sender?: { login?: unknown } }).sender?.login;
    await this.events.publish([
      createEvent({
        type: `github.installation_${AUDITED[change.action]}`,
        organizationId,
        actor: SYSTEM_ACTOR,
        target: { type: 'github_installation', id: String(change.installationId) },
        payload: {
          installationId: change.installationId,
          accountLogin: change.accountLogin,
          accountType: change.accountType,
          repositorySelection: change.repositorySelection,
          githubSender: typeof sender === 'string' && LOGIN.test(sender) ? sender : null,
        },
        occurredAt: now,
      }),
    ]);
    return 'applied';
  }
}
