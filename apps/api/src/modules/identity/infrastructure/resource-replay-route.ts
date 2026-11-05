import { isTenantId } from '@shipkeep/domain';

/** Closed POST creation/settings and membership routes; never permits resource deletion or
 * arbitrary resource paths. Removing a membership is idempotent and revoked by the live
 * `member.manage` recheck on every replay.
 */
export function resourceReplayRoute(route: string): boolean {
  const parts = route.split('/');
  if (parts[0] !== 'organizations') return false;
  if (parts.length === 1) return true;
  if (!isTenantId(parts[1])) return false;
  if (parts.length === 3)
    return parts[2] === 'settings' || parts[2] === 'projects' || parts[2] === 'members';
  if (parts.length === 5 && parts[2] === 'members')
    return isTenantId(parts[3]) && (parts[4] === 'role' || parts[4] === 'remove');
  if (parts[2] !== 'projects' || !isTenantId(parts[3])) return false;
  if (parts.length === 5) return parts[4] === 'settings' || parts[4] === 'environments';
  return (
    parts.length === 7 &&
    parts[4] === 'environments' &&
    isTenantId(parts[5]) &&
    parts[6] === 'settings'
  );
}
