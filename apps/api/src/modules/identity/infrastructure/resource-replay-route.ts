import { isTenantId } from '@shipkeep/domain';

/** Closed POST creation/settings routes; never permits deletion or arbitrary resource paths. */
export function resourceReplayRoute(route: string): boolean {
  const parts = route.split('/');
  if (parts[0] !== 'organizations') return false;
  if (parts.length === 1) return true;
  if (!isTenantId(parts[1])) return false;
  if (parts.length === 3) return parts[2] === 'settings' || parts[2] === 'projects';
  if (parts[2] !== 'projects' || !isTenantId(parts[3])) return false;
  if (parts.length === 5) return parts[4] === 'settings' || parts[4] === 'environments';
  return (
    parts.length === 7 &&
    parts[4] === 'environments' &&
    isTenantId(parts[5]) &&
    parts[6] === 'settings'
  );
}
