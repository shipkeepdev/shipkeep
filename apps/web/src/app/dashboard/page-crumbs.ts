import { Injectable, inject, signal } from '@angular/core';
import { type ActivatedRouteSnapshot, type Event, ResolveEnd } from '@angular/router';
import { filter, type Observable, type Subscription } from 'rxjs';

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

/**
 * Puts the route's own crumbs (`data.crumbs`) in the trail when a navigation resolves, before its
 * page is created, and never after: a page that knows its names at once, from a cache, sets its
 * trail while it is created, and a reset when the navigation ends would replace it. A navigation
 * that stays on the same page with the same parameters, such as another section in the query,
 * keeps the page's trail.
 */
@Injectable({ providedIn: 'root' })
export class RouteCrumbs {
  private readonly crumbs = inject(PageCrumbs);
  private page: string | undefined;

  /** `snapshot` may be any route of the state: the key always starts from its root. */
  apply(snapshot: ActivatedRouteSnapshot): void {
    let route = snapshot.root;
    const chain = [key(route)];
    while (route.firstChild) {
      route = route.firstChild;
      chain.push(key(route));
    }
    const page = chain.join('/');
    if (page === this.page) return;
    this.page = page;
    const labels = (route.data['crumbs'] as readonly string[] | undefined) ?? [];
    this.crumbs.set(labels.map((label) => ({ label })));
  }

  watch(events: Observable<Event>): Subscription {
    return events
      .pipe(filter((event): event is ResolveEnd => event instanceof ResolveEnd))
      .subscribe((event) => {
        this.apply(event.state.root);
      });
  }
}

function key(route: ActivatedRouteSnapshot): string {
  return `${route.routeConfig?.path ?? ''}${JSON.stringify(route.params)}`;
}
