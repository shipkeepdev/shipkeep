import { Code, ConnectError } from '@connectrpc/connect';

import type { AppConfig } from '../../../platform/config/app-config';
import { clientNetwork } from '../../identity/domain/client-network';

export interface EnrollmentLimits {
  /** Enrollment attempts one client network (IPv4 address or IPv6 /64) may make per window. */
  readonly perNetwork: number;
  readonly windowMs: number;
  /** Networks tracked at once; beyond that, new networks share one quota. */
  readonly maxNetworks: number;
  /** Enrollments doing database work at once, across every connection. */
  readonly concurrent: number;
  /** Enrollments waiting for a slot; one more is refused at once. */
  readonly queued: number;
  /** How long an enrollment waits for a slot before it is refused. */
  readonly maxWaitMs: number;
}

/**
 * Generous for a fleet: an agent retries every 5 seconds after a failure (its systemd unit), and
 * several servers behind one address may enroll together. Each enrollment holds a database
 * connection for a few milliseconds, so four at once serve dozens of agents per second.
 */
export const ENROLLMENT_LIMITS: EnrollmentLimits = {
  perNetwork: 20,
  windowMs: 60_000,
  maxNetworks: 10_000,
  concurrent: 4,
  queued: 32,
  maxWaitMs: 10_000,
};

/** The quota key shared by networks beyond `maxNetworks`, and by a peer without an address. */
const SHARED = 'shared';

/** The deliberate answer of a full gateway: no token state, nothing the caller sent. */
export function enrollmentBusy(): ConnectError {
  return new ConnectError('enrollment is busy, retry later', Code.ResourceExhausted);
}

/**
 * Admission in front of the enrollment RPC (#346), in memory and before any database work: a
 * quota per client network, then a global budget of enrollments at once with a bounded queue.
 * One control plane process serves the gateway, so its memory is the whole budget.
 */
export class EnrollmentAdmission {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly limits: EnrollmentLimits = ENROLLMENT_LIMITS,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The gateway's admission, with the per-network quota the installation configured. */
  static fromConfig(config: AppConfig): EnrollmentAdmission {
    return new EnrollmentAdmission({
      ...ENROLLMENT_LIMITS,
      perNetwork: config.get('AGENT_ENROLLMENTS_PER_MINUTE'),
    });
  }

  /** Counts one attempt from this peer address; false once its network spent its quota. */
  allow(ip: string | undefined): boolean {
    const now = this.clock();
    let key = ip ? clientNetwork(ip) : SHARED;
    let window = this.windows.get(key);
    if (!window && this.windows.size >= this.limits.maxNetworks) {
      this.sweep(now);
      if (this.windows.size >= this.limits.maxNetworks) {
        key = SHARED;
        window = this.windows.get(key);
      }
    }
    if (!window || now - window.start >= this.limits.windowMs) {
      window = { start: now, count: 0 };
      // Re-inserted, so the map stays ordered by window start for the sweep.
      this.windows.delete(key);
      this.windows.set(key, window);
    }
    if (window.count >= this.limits.perNetwork) return false;
    window.count++;
    return true;
  }

  /**
   * Runs `work` within the global budget. Waits at most `maxWaitMs` for a slot, and throws
   * ResourceExhausted when the queue is full, the wait ends, or the caller gave up meanwhile.
   */
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  /** Enrollments running and waiting, for tests and diagnostics. */
  load(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(enrollmentBusy());
    if (this.running < this.limits.concurrent) {
      this.running++;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.limits.queued) return Promise.reject(enrollmentBusy());
    return new Promise<void>((resolve, reject) => {
      const leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abandon);
        const index = this.waiting.indexOf(grant);
        if (index >= 0) this.waiting.splice(index, 1);
      };
      // The slot passes from release() to this waiter without being counted free in between.
      const grant = () => {
        leave();
        resolve();
      };
      const abandon = () => {
        leave();
        reject(enrollmentBusy());
      };
      const timer = setTimeout(abandon, this.limits.maxWaitMs);
      signal?.addEventListener('abort', abandon, { once: true });
      this.waiting.push(grant);
    });
  }

  private release(): void {
    const next = this.waiting.at(0);
    if (next) next();
    else this.running--;
  }

  /** Forgets the networks whose window ended; the map is ordered by window start. */
  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start < this.limits.windowMs) break;
      this.windows.delete(key);
    }
  }
}
