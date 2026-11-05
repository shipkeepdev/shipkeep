import { isTenantId } from '@shipkeep/domain';

/**
 * Closed POST creation/settings, membership and role-binding routes. It never permits resource
 * deletion or arbitrary resource paths. Removing a membership or binding is idempotent, and every
 * replay rechecks live `member.manage`.
 */
export function resourceReplayRoute(route: string): boolean {
  const parts = route.split('/');
  if (parts[0] !== 'organizations') return false;
  if (parts.length === 1) return true;
  if (!isTenantId(parts[1])) return false;
  const rest = parts.slice(2);
  if (rest[0] === 'members') return memberRoute(rest.slice(1), ['role', 'remove']);
  if (rest.length === 1) return rest[0] === 'settings' || rest[0] === 'projects';
  if (rest[0] !== 'projects' || !isTenantId(rest[1])) return false;
  // Inside a project: `settings`, `environments`, `bindings[/<membership>/remove]`, or the same
  // inside one environment (without `environments`).
  const project = rest.slice(2);
  if (project[0] === 'bindings') return memberRoute(project.slice(1), ['remove']);
  // Only revocation: listing is a GET and creation goes through `/api-tokens`.
  if (project[0] === 'api-tokens')
    return project.length === 3 && isTenantId(project[1]) && project[2] === 'revoke';
  if (project.length === 1) return project[0] === 'settings' || project[0] === 'environments';
  if (project[0] !== 'environments' || !isTenantId(project[1])) return false;
  const environment = project.slice(2);
  if (environment[0] === 'bindings') return memberRoute(environment.slice(1), ['remove']);
  return environment.length === 1 && environment[0] === 'settings';
}

/** The collection itself, or `<membership id>/<action>` with an allowed action. */
function memberRoute(parts: readonly string[], actions: readonly string[]): boolean {
  if (parts.length === 0) return true;
  return parts.length === 2 && isTenantId(parts[0]) && actions.includes(parts[1]);
}
