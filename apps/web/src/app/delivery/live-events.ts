import { DOCUMENT } from '@angular/common';
import { inject, Injectable, InjectionToken, signal } from '@angular/core';

import type { EnvironmentRef } from './delivery-api';

/** Absent where the browser has no EventSource; pages then keep polling. */
export const EVENT_SOURCE = new InjectionToken<((url: string) => EventSource) | null>(
  'EventSource',
  {
    providedIn: 'root',
    factory: () => (typeof EventSource === 'undefined' ? null : (url) => new EventSource(url)),
  },
);

/** Hints that something changed in an environment (SPEC 8); data still comes from the API. */
@Injectable({ providedIn: 'root' })
export class LiveEvents {
  private readonly origin = inject(DOCUMENT).location.origin;
  private readonly open = inject(EVENT_SOURCE);
  private readonly live = signal(false);
  readonly connected = this.live.asReadonly();

  /** The browser reconnects by itself, resuming after the last event it received. */
  connect(
    environment: EnvironmentRef,
    changed: (applicationId: string | undefined) => void,
  ): { close(): void } | null {
    if (!this.open) return null;
    const { organizationId, projectId, environmentId } = environment;
    const source = this.open(
      `${this.origin}/api/v1/organizations/${organizationId}/projects/${projectId}/environments/${environmentId}/events`,
    );
    source.onopen = () => {
      this.live.set(true);
    };
    source.onerror = () => {
      this.live.set(false);
    };
    source.addEventListener('change', (event) => {
      changed(applicationOf((event as MessageEvent<string>).data));
    });
    return {
      close: () => {
        source.close();
        this.live.set(false);
      },
    };
  }
}

function applicationOf(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as { applicationId?: unknown };
    return typeof parsed.applicationId === 'string' ? parsed.applicationId : undefined;
  } catch {
    return undefined;
  }
}
