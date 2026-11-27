import { createHash } from 'node:crypto';

/**
 * Tokens of the installation's own registry (ADR 0030). The registry (CNCF Distribution) refuses
 * a request without a bearer token and names the control plane's token endpoint. The Docker
 * daemon and BuildKit call it with the user name and password an action carries, and send the
 * token it answers. Pure: no HTTP, no storage, no clock of its own.
 */

/** How long a token lasts. A pull or a push asks for a new one when it runs out. */
export const REGISTRY_TOKEN_SECONDS = 300;
/** Who signs the tokens: Distribution's `auth.token.issuer`. */
export const REGISTRY_TOKEN_ISSUER = 'shipkeep';
/** Bytes of randomness in a grant's secret, sent base64url as the password of basic auth. */
export const REGISTRY_SECRET_BYTES = 32;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const USERNAME = new RegExp(`^(${UUID})\\.(${UUID})$`);
const SECRET = /^[A-Za-z0-9_-]{43}$/;
/** A scope Docker sends: `repository:<name>:<actions>`. Names and actions are checked below. */
const SCOPE = /^repository:([a-z0-9][a-z0-9._/-]{0,254}):([a-z,*]{1,32})$/;
const MAX_SCOPES = 8;

export type RegistryAction = 'pull' | 'push' | 'delete' | '*';

/** One entry of a token's `access` claim. */
export interface RegistryAccess {
  readonly type: 'repository' | 'registry';
  readonly name: string;
  readonly actions: RegistryAction[];
}

/** Who the control plane's own tokens are for: the retention of the registry's images. */
export const RETENTION_SUBJECT = 'shipkeep-retention';

/**
 * What the retention may do, never a grant (ADR 0030): list the registry's repositories, or read
 * and delete the manifests of one.
 */
export function retentionAccess(repository?: string): RegistryAccess[] {
  return repository === undefined
    ? [{ type: 'registry', name: 'catalog', actions: ['*'] }]
    : [{ type: 'repository', name: repository, actions: ['pull', 'delete'] }];
}

/** What a grant allows: its application's repository, and pushing to it or not. */
export interface GrantedRepository {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly push: boolean;
}

/** An application's repository in the registry, under the control plane's name. */
export function applicationRepository(organizationId: string, applicationId: string): string {
  return `${organizationId}/${applicationId}`;
}

/**
 * A grant's user name names its organization too: the token endpoint is anonymous and reads the
 * grant within that organization's tenant scope.
 */
export function grantUsername(organizationId: string, grantId: string): string {
  return `${organizationId}.${grantId}`;
}

export function parseGrantUsername(
  value: string,
): { organizationId: string; grantId: string } | undefined {
  const match = USERNAME.exec(value);
  return match?.[1] && match[2] ? { organizationId: match[1], grantId: match[2] } : undefined;
}

/** A secret this endpoint could have issued: anything else is refused before any lookup. */
export function wellFormedSecret(value: string): boolean {
  return SECRET.test(value);
}

/**
 * What is stored of a grant's secret: its SHA-256, bound to this purpose as API tokens are. The
 * secret is 32 random bytes, not a person's password: a slow hash would add nothing.
 */
export function grantSecretHash(secret: string): string {
  return createHash('sha256')
    .update('shipkeep:registry_grant:')
    .update(secret, 'utf8')
    .digest('hex');
}

/**
 * Reads a basic authorization header: the user name, and the secret sent as its password.
 * Undefined for any other scheme or a malformed value.
 */
export function basicCredentials(
  header: string | undefined,
): { username: string; secret: string } | undefined {
  if (!header || header.length > 512) return undefined;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match?.[1]) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return undefined;
  return { username: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}

/**
 * The scopes a request asks for. Anything but repository scopes, more than eight, or a name or
 * action list this registry never uses is dropped, not refused: Docker asks with what it has.
 */
export function requestedScopes(values: readonly string[]): RegistryAccess[] {
  const scopes: RegistryAccess[] = [];
  for (const value of values.slice(0, MAX_SCOPES)) {
    const match = SCOPE.exec(value);
    if (!match?.[1] || !match[2]) continue;
    const name = match[1];
    if (name.split('/').some((part) => part === '' || part === '.' || part === '..')) continue;
    const actions = [
      ...new Set(
        match[2]
          .split(',')
          .flatMap((action): RegistryAction[] =>
            action === 'pull' || action === 'push'
              ? [action]
              : action === '*'
                ? ['pull', 'push']
                : [],
          ),
      ),
    ];
    if (actions.length) scopes.push({ type: 'repository', name, actions });
  }
  return scopes;
}

/**
 * What a token grants: of what was asked, only the grant's repository, with pull, and push when
 * the grant allows it. Everything else is left out; the registry then refuses it.
 */
export function grantedAccess(
  grant: GrantedRepository,
  requested: readonly RegistryAccess[],
): RegistryAccess[] {
  const repository = applicationRepository(grant.organizationId, grant.applicationId);
  const allowed = new Set<RegistryAction>(grant.push ? ['pull', 'push'] : ['pull']);
  const actions = new Set<RegistryAction>();
  for (const scope of requested)
    if (scope.name === repository)
      for (const action of scope.actions) if (allowed.has(action)) actions.add(action);
  return actions.size
    ? [
        {
          type: 'repository',
          name: repository,
          actions: (['pull', 'push'] as const).filter((a) => actions.has(a)),
        },
      ]
    : [];
}

/** The claims of a token, as Distribution's token authentication reads them. */
export interface RegistryTokenClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly exp: number;
  readonly nbf: number;
  readonly iat: number;
  readonly jti: string;
  readonly access: RegistryAccess[];
}

/**
 * A token's claims: for the registry served under `service`, five minutes at most and never past
 * the grant's own deadline. `nbf` allows a few seconds of clock difference with the registry.
 */
export function tokenClaims(input: {
  service: string;
  subject: string;
  access: RegistryAccess[];
  id: string;
  now: Date;
  grantExpiresAt: Date;
}): RegistryTokenClaims {
  const iat = Math.floor(input.now.getTime() / 1000);
  const exp = Math.min(
    iat + REGISTRY_TOKEN_SECONDS,
    Math.floor(input.grantExpiresAt.getTime() / 1000),
  );
  return {
    iss: REGISTRY_TOKEN_ISSUER,
    sub: input.subject,
    aud: input.service,
    exp,
    nbf: iat - 10,
    iat,
    jti: input.id,
    access: input.access,
  };
}

/** The signing input of a compact JWS: the encoded header and claims. */
export function signingInput(keyId: string, claims: RegistryTokenClaims): string {
  const header = { alg: 'EdDSA', typ: 'JWT', kid: keyId };
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
}

export function compactToken(input: string, signature: Uint8Array): string {
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
