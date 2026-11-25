import { InvalidInputError, Secret } from '@shipkeep/domain';

/** GitHub refuses an App name longer than this. */
export const GITHUB_APP_NAME_MAX = 34;
/** How long an owner has to come back from GitHub with the App created. */
export const GITHUB_APP_FLOW_MS = 60 * 60_000;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CLIENT_ID = /^[A-Za-z0-9.]{1,64}$/;
const SUFFIX = /^[a-z0-9]{6}$/;
const CODE = /^[A-Za-z0-9_-]{1,128}$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRIVATE_KEY =
  /^-----BEGIN (?:RSA )?PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END (?:RSA )?PRIVATE KEY-----\n?$/;

/** What the interface shows of an organization's App: never its secrets. */
export interface GithubAppMetadata {
  readonly appId: number;
  readonly slug: string;
  readonly name: string;
  readonly ownerLogin: string;
  readonly createdAt: Date;
}

/** The App GitHub created, as its manifest conversion answers it. */
export interface CreatedGithubApp {
  readonly appId: number;
  readonly slug: string;
  readonly name: string;
  readonly ownerLogin: string;
  readonly clientId: string;
  readonly clientSecret: Secret;
  readonly webhookSecret: Secret;
  readonly privateKey: Secret;
}

/** The manifest GitHub creates the App from (ADR 0031). */
export interface GithubAppManifest {
  readonly name: string;
  readonly url: string;
  readonly hook_attributes: { readonly url: string; readonly active: true };
  readonly redirect_url: string;
  readonly setup_url: string;
  readonly setup_on_update: true;
  readonly public: false;
  readonly default_permissions: Readonly<Record<string, 'read' | 'write'>>;
  readonly default_events: readonly string[];
}

/** The App's page on GitHub. */
export function githubAppUrl(slug: string): string {
  return `https://github.com/apps/${slug}`;
}

/**
 * The App's name: `Shipkeep <organization slug> <suffix>`. GitHub names are global, hence the random
 * suffix, and at most 34 characters, so the slug is cut to fit.
 */
export function githubAppName(organizationSlug: string, suffix: string): string {
  if (!SUFFIX.test(suffix)) throw new Error('invalid App name suffix');
  const room = GITHUB_APP_NAME_MAX - 'Shipkeep  '.length - suffix.length;
  const slug = organizationSlug.slice(0, room).replace(/-+$/, '');
  return slug ? `Shipkeep ${slug} ${suffix}` : `Shipkeep ${suffix}`;
}

/**
 * The App's manifest: private, with the permissions ADR 0031 asks for once, its webhook on this
 * installation, and the interface page GitHub sends the owner back to after creating or installing
 * it.
 */
export function githubAppManifest(input: {
  readonly name: string;
  readonly publicUrl: string;
  readonly organizationId: string;
}): GithubAppManifest {
  if (!UUID.test(input.organizationId)) throw new Error('invalid organization identifier');
  const origin = publicOrigin(input.publicUrl);
  const page = `${origin}/orgs/${input.organizationId}/integrations/github`;
  return {
    name: input.name,
    url: origin,
    hook_attributes: {
      url: `${origin}/api/v1/webhooks/github/${input.organizationId}`,
      active: true,
    },
    redirect_url: page,
    setup_url: page,
    setup_on_update: true,
    public: false,
    default_permissions: {
      metadata: 'read',
      contents: 'write',
      pull_requests: 'write',
      statuses: 'write',
    },
    default_events: ['push'],
  };
}

/** Where the owner's browser posts the manifest: their own account, or a GitHub organization. */
export function githubAppCreationUrl(state: string, githubOrganization?: string): string {
  if (!STATE.test(state)) throw new Error('invalid state');
  if (githubOrganization === undefined)
    return `https://github.com/settings/apps/new?state=${state}`;
  if (!LOGIN.test(githubOrganization))
    throw new InvalidInputError('github_account_invalid', 'This is not a GitHub account name.');
  return `https://github.com/organizations/${githubOrganization}/settings/apps/new?state=${state}`;
}

/** The temporary code GitHub hands back, or an error when it cannot be one. */
export function githubManifestCode(code: string, state: string): void {
  if (!CODE.test(code) || !STATE.test(state)) throw flowInvalid();
}

/** The flow cannot be completed: its state is unknown, expired or someone else's. */
export function flowInvalid(): InvalidInputError {
  return new InvalidInputError(
    'github_app_flow_invalid',
    'The GitHub App could not be connected. Start again from the integrations page.',
  );
}

/** GitHub's answer to the manifest conversion, checked field by field; secrets wrapped at once. */
export function createdGithubApp(raw: unknown): CreatedGithubApp {
  if (!raw || typeof raw !== 'object') throw answerInvalid();
  const value = raw as Record<string, unknown>;
  const owner = value['owner'];
  const ownerLogin =
    owner && typeof owner === 'object' ? (owner as Record<string, unknown>)['login'] : undefined;
  const { id, slug, name } = value;
  const clientId = value['client_id'];
  const clientSecret = value['client_secret'];
  const webhookSecret = value['webhook_secret'];
  const pem = value['pem'];
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof slug !== 'string' ||
    !SLUG.test(slug) ||
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > GITHUB_APP_NAME_MAX ||
    typeof ownerLogin !== 'string' ||
    !LOGIN.test(ownerLogin) ||
    typeof clientId !== 'string' ||
    !CLIENT_ID.test(clientId) ||
    !secretText(clientSecret) ||
    !secretText(webhookSecret) ||
    typeof pem !== 'string' ||
    pem.length > 8192 ||
    !PRIVATE_KEY.test(pem)
  )
    throw answerInvalid();
  return {
    appId: id,
    slug,
    name,
    ownerLogin,
    clientId,
    clientSecret: new Secret(clientSecret),
    webhookSecret: new Secret(webhookSecret),
    privateKey: new Secret(pem),
  };
}

function secretText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 256;
}

function answerInvalid(): InvalidInputError {
  return new InvalidInputError(
    'github_app_answer_invalid',
    'GitHub answered with an App this installation cannot use.',
  );
}

function publicOrigin(publicUrl: string): string {
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('invalid public URL');
  return url.origin;
}
