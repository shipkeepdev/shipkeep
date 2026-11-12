import { Injectable, signal } from '@angular/core';

/**
 * The breadcrumb trail of the top bar after the organization name. The layout resets it to the
 * route's `data.crumbs` on each navigation; a page with names from the API sets it once loaded.
 * Labels are English source text unless `raw` (names typed by users are never translated).
 */
export interface Crumb {
  readonly label: string;
  readonly raw?: boolean;
  readonly link?: readonly string[];
}

@Injectable({ providedIn: 'root' })
export class PageCrumbs {
  readonly trail = signal<readonly Crumb[]>([]);
  set(trail: readonly Crumb[]): void {
    this.trail.set(trail);
  }
}
