import { clientNetwork } from './client-network';

export const FAILED_SESSION_LIMIT = 30;
export const FAILED_SESSION_WINDOW_MS = 60_000;
const MAX_NETWORKS = 10_000;

/**
 * Counts session cookies that did not authenticate, per client network, in memory. A cookie with
 * the right shape costs a database lookup before it can be refused, so a network that keeps
 * sending unknown ones is turned away before that lookup for the rest of the window. Requests
 * that authenticate are never counted. The count is per process and lost at restart: it sheds
 * load, it is not an account lockout.
 */
export class FailedSessions {
  private readonly networks = new Map<string, { count: number; since: number }>();

  /** When the network may try again, or undefined when it is not held back. */
  blockedUntil(ip: string, now: number): number | undefined {
    const entry = this.networks.get(clientNetwork(ip));
    if (!entry) return undefined;
    if (now - entry.since >= FAILED_SESSION_WINDOW_MS) {
      this.networks.delete(clientNetwork(ip));
      return undefined;
    }
    return entry.count >= FAILED_SESSION_LIMIT ? entry.since + FAILED_SESSION_WINDOW_MS : undefined;
  }

  record(ip: string, now: number): void {
    const network = clientNetwork(ip);
    const entry = this.networks.get(network);
    if (entry && now - entry.since < FAILED_SESSION_WINDOW_MS) {
      entry.count += 1;
      return;
    }
    if (this.networks.size >= MAX_NETWORKS) this.forget(now);
    this.networks.set(network, { count: 1, since: now });
  }

  /** Bounded memory: drop finished windows, and everything if that is not enough. */
  private forget(now: number): void {
    for (const [network, entry] of this.networks)
      if (now - entry.since >= FAILED_SESSION_WINDOW_MS) this.networks.delete(network);
    if (this.networks.size >= MAX_NETWORKS) this.networks.clear();
  }
}
