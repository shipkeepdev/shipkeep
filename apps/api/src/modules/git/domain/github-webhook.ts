import { DomainError, InvalidInputError } from '@shipkeep/domain';

/** A larger body is refused unread (ADR 0031). */
export const MAX_WEBHOOK_BYTES = 1 << 20;
/** How long a delivery identifier is kept, so that the same delivery again does nothing. */
export const DELIVERY_RETENTION_MS = 30 * 86_400_000;

const EVENT = /^[a-z_]{1,64}$/;
const DELIVERY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** A delivery that is not GitHub's for this organization: same answer whatever the reason. */
export class WebhookRejected extends DomainError {
  readonly kind = 'unauthorized' as const;
  readonly code = 'github_webhook_rejected';
  constructor() {
    super('This delivery is not signed by the organization’s GitHub App.');
  }
}

/** What GitHub's headers say of a delivery, checked before the body is looked at. */
export interface DeliveryHeaders {
  readonly event: string;
  readonly delivery: string;
  /** The HMAC-SHA256 of the body, hexadecimal, as `X-Hub-Signature-256` carries it. */
  readonly signature: string;
}

export function deliveryHeaders(headers: {
  readonly event?: string | undefined;
  readonly delivery?: string | undefined;
  readonly signature?: string | undefined;
}): DeliveryHeaders {
  const signature = SIGNATURE.exec(headers.signature ?? '')?.[1];
  if (!signature) throw new WebhookRejected();
  const event = headers.event ?? '';
  const delivery = (headers.delivery ?? '').toLowerCase();
  if (!EVENT.test(event) || !DELIVERY.test(delivery))
    throw new InvalidInputError('github_webhook_invalid', 'This is not a GitHub delivery.');
  return { event, delivery, signature };
}

/** An installation of the organization's App, as an `installation` event describes it. */
export interface InstallationChange {
  readonly action: 'created' | 'deleted' | 'suspend' | 'unsuspend';
  readonly installationId: number;
  readonly accountLogin: string;
  readonly accountType: 'User' | 'Organization';
  readonly repositorySelection: 'all' | 'selected';
}

const ACTIONS = new Set(['created', 'deleted', 'suspend', 'unsuspend']);

/**
 * The change an `installation` event makes, or undefined for an action that changes nothing here
 * (`new_permissions_accepted`). An installation of another App is refused: the payload is signed by
 * this organization's App, so it names that App.
 */
export function installationChange(
  payload: unknown,
  appId: number,
): InstallationChange | undefined {
  const value = record(payload);
  const installation = record(value?.['installation']);
  const account = record(installation?.['account']);
  const action = value?.['action'];
  const installationId = installation?.['id'];
  const accountLogin = account?.['login'];
  const accountType = account?.['type'];
  const repositorySelection = installation?.['repository_selection'];
  if (
    typeof action !== 'string' ||
    typeof installationId !== 'number' ||
    !Number.isSafeInteger(installationId) ||
    installationId <= 0 ||
    installation?.['app_id'] !== appId ||
    typeof accountLogin !== 'string' ||
    !LOGIN.test(accountLogin) ||
    (accountType !== 'User' && accountType !== 'Organization') ||
    (repositorySelection !== 'all' && repositorySelection !== 'selected')
  )
    throw new InvalidInputError('github_webhook_invalid', 'This installation event is malformed.');
  if (!ACTIONS.has(action)) return undefined;
  return {
    action: action as InstallationChange['action'],
    installationId,
    accountLogin,
    accountType,
    repositorySelection,
  };
}

/** The App a `ping` names: it must be this organization's. */
export function pingedApp(payload: unknown): number | undefined {
  const hook = record(record(payload)?.['hook']);
  const appId = hook?.['app_id'];
  return typeof appId === 'number' && Number.isSafeInteger(appId) ? appId : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
