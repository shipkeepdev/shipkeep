import { type Deployment } from '../delivery/delivery-api';
import { type FleetNode } from '../fleet/fleet-api';

/** Status colors of the design. */
export const GREEN = 'oklch(0.78 0.13 155)';
export const AMBER = 'oklch(0.80 0.12 80)';
export const RED = 'oklch(0.68 0.17 25)';
export const BLUE = 'oklch(0.72 0.13 250)';
export const GREY = '#7C7C85';

export interface Status {
  /** English source text. */
  readonly label: string;
  readonly color: string;
}

export function deploymentStatus(state: Deployment['state']): Status {
  switch (state) {
    case 'succeeded':
      return { label: 'live', color: GREEN };
    case 'failed':
      return { label: 'failed', color: RED };
    case 'cancelled':
      return { label: 'cancelled', color: GREY };
    case 'rolled_back':
      return { label: 'rolled back', color: AMBER };
    case 'health_checking':
      return { label: 'health check', color: BLUE };
    default:
      return { label: state.replace('_', ' '), color: BLUE };
  }
}

export function nodeStatus(status: FleetNode['status']): Status {
  switch (status) {
    case 'ready':
      return { label: 'ready', color: GREEN };
    case 'suspect':
      return { label: 'suspect', color: AMBER };
    case 'down':
      return { label: 'down', color: RED };
    case 'draining':
      return { label: 'draining', color: BLUE };
    case 'enrolling':
      return { label: 'enrolling', color: BLUE };
    default:
      return { label: 'removed', color: GREY };
  }
}

/** "74 s", "2 min", "1 h 5 min": the length of a deployment, or how long it has been running. */
export function duration(from: string, to: string | null, now = Date.now()): string {
  const seconds = Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 1000));
  if (seconds < 100) return `${String(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
}

/** Seconds since a moment, for heartbeats. */
export function ageSeconds(at: string | null, now = Date.now()): number | null {
  return at ? Math.max(0, Math.round((now - Date.parse(at)) / 1000)) : null;
}

export function bytes(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const gib = value / 1024 ** 3;
  return gib >= 1
    ? `${String(gib >= 10 ? Math.round(gib) : Number(gib.toFixed(1)))} GiB`
    : `${String(Math.round(value / 1024 ** 2))} MiB`;
}

export function percent(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0;
}

/** dd/MM HH:mm, as the design writes times in tables. */
export function shortDate(at: string): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(date.getDate())}/${two(date.getMonth() + 1)} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function clock(at: string): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
