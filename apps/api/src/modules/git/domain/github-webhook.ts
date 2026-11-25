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
  // Headers reach here as strings, or not at all: anything else is refused as missing.
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const signature = SIGNATURE.exec(text(headers.signature))?.[1];
  if (!signature) throw new WebhookRejected();
  const event = text(headers.event);
  const delivery = text(headers.delivery).toLowerCase();
  if (!EVENT.test(event) || !DELIVERY.test(delivery))
    throw new InvalidInputError('github_webhook_invalid', 'This is not a GitHub delivery.');
  return { event, delivery, signature };
}

/** An installation of the organization's App, as an `installation` event describes it. */
export interface InstallationChange {
  /** `repositories` is an `installation_repositories` event: the selection changed. */
  readonly action: 'created' | 'deleted' | 'suspend' | 'unsuspend' | 'repositories';
  readonly installationId: number;
  readonly accountLogin: string;
  readonly accountType: 'User' | 'Organization';
  readonly repositorySelection: 'all' | 'selected';
  /** GitHub's time of the change: one no newer than what is recorded changes nothing. */
  readonly updatedAt: Date;
}

/** What an installation's order keeps: GitHub's time of its last change, and its states. */
export interface RecordedInstallation {
  readonly updatedAt: Date;
  readonly suspendedAt: Date | null;
  /** Set once removed: the row stays as a tombstone. */
  readonly deletedAt: Date | null;
}

/**
 * Whether a change applies after the state recorded (#475, #476). A removed installation never
 * comes back, since installing the App again makes a new one: nothing applies to it any more. A
 * removal applies whatever its time. Any other change applies when it is newer, or at the same
 * time when it is more restrictive: a suspension of an active installation. Any other change at
 * the same time, a replay among them, changes nothing, so the state kept is never the less
 * restrictive one.
 */
export function changeApplies(
  change: InstallationChange,
  recorded: RecordedInstallation | null | undefined,
): boolean {
  if (recorded?.deletedAt) return false;
  if (change.action === 'deleted' || !recorded) return true;
  const at = change.updatedAt.getTime();
  const last = recorded.updatedAt.getTime();
  if (at !== last) return at > last;
  return change.action === 'suspend' && recorded.suspendedAt === null;
}

const ACTIONS = new Set(['created', 'deleted', 'suspend', 'unsuspend']);
/** GitHub's clock may run a little ahead of this one, never much. */
const MAX_AHEAD_MS = 5 * 60_000;

/**
 * The change an `installation` or `installation_repositories` event makes, or undefined for one
 * that changes nothing here (`new_permissions_accepted`). An installation of another App is
 * refused: the payload is signed by this organization's App, so it names that App.
 */
export function installationChange(
  event: 'installation' | 'installation_repositories',
  payload: unknown,
  appId: number,
  now: Date,
): InstallationChange | undefined {
  const value = record(payload);
  const installation = record(value?.['installation']);
  const account = record(installation?.['account']);
  const action = value?.['action'];
  const installationId = installation?.['id'];
  const accountLogin = account?.['login'];
  const accountType = account?.['type'];
  const repositorySelection = installation?.['repository_selection'];
  const updatedAt = githubTime(installation?.['updated_at']);
  if (
    typeof action !== 'string' ||
    typeof installationId !== 'number' ||
    !Number.isSafeInteger(installationId) ||
    installationId <= 0 ||
    installation?.['app_id'] !== appId ||
    typeof accountLogin !== 'string' ||
    !LOGIN.test(accountLogin) ||
    (accountType !== 'User' && accountType !== 'Organization') ||
    (repositorySelection !== 'all' && repositorySelection !== 'selected') ||
    !updatedAt ||
    updatedAt.getTime() > now.getTime() + MAX_AHEAD_MS
  )
    throw new InvalidInputError('github_webhook_invalid', 'This installation event is malformed.');
  const change: Omit<InstallationChange, 'action'> = {
    installationId,
    accountLogin,
    accountType,
    repositorySelection,
    updatedAt,
  };
  if (event === 'installation_repositories')
    return action === 'added' || action === 'removed'
      ? { action: 'repositories', ...change }
      : undefined;
  if (!ACTIONS.has(action)) return undefined;
  return { action: action as InstallationChange['action'], ...change };
}

/** A time as GitHub writes it, ISO 8601 with its offset, or undefined. */
function githubTime(value: unknown): Date | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return undefined;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time : undefined;
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
