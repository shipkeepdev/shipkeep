import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  type Event,
  NavigationEnd,
  ResolveEnd,
  type RouterStateSnapshot,
} from '@angular/router';
import { Subject } from 'rxjs';

import { PageCrumbs, RouteCrumbs } from './page-crumbs';

/** A snapshot chain from the root to a page, as the router builds it. */
function state(
  pages: readonly { path: string; params?: Record<string, string>; crumbs?: string[] }[],
): RouterStateSnapshot {
  const nodes = pages.map(
    (page) =>
      ({
        routeConfig: { path: page.path },
        params: page.params ?? {},
        data: page.crumbs ? { crumbs: page.crumbs } : {},
        firstChild: null,
        root: null,
      }) as { firstChild: unknown; root: unknown },
  );
  nodes.forEach((node, index) => {
    node.firstChild = nodes[index + 1] ?? null;
    node.root = nodes[0];
  });
  return { root: nodes[0] } as unknown as RouterStateSnapshot;
}

const applicationPage = (applicationId: string) =>
  state([
    { path: '' },
    { path: 'orgs/:organizationId', params: { organizationId: 'org-1' } },
    {
      path: 'projects/:projectId/environments/:environmentId/applications/:applicationId',
      params: { projectId: 'p', environmentId: 'e', applicationId },
      crumbs: ['Applications'],
    },
  ]);

describe('the trail a route puts in the top bar', () => {
  let events: Subject<Event>;
  let crumbs: PageCrumbs;

  beforeEach(() => {
    events = new Subject<Event>();
    crumbs = TestBed.inject(PageCrumbs);
    TestBed.inject(RouteCrumbs).watch(events);
  });

  const labels = () => crumbs.trail().map((crumb) => crumb.label);

  it('goes in before the page, so that a page which knows its names at once keeps them', () => {
    events.next(new ResolveEnd(1, '/a', '/a', applicationPage('app-1')));
    expect(labels()).toEqual(['Applications']);
    // The page is created and finds the application in a cache: it sets its own trail at once.
    crumbs.set([
      { label: 'Storefront', raw: true },
      { label: 'storefront', raw: true },
    ]);
    events.next(new NavigationEnd(1, '/a', '/a'));
    expect(labels()).toEqual(['Storefront', 'storefront']);
  });

  it('stays when the navigation keeps the page and its parameters, such as a section in the query', () => {
    events.next(new ResolveEnd(1, '/a', '/a', applicationPage('app-1')));
    crumbs.set([{ label: 'storefront', raw: true }]);
    events.next(
      new ResolveEnd(2, '/a?section=domains', '/a?section=domains', applicationPage('app-1')),
    );
    expect(labels()).toEqual(['storefront']);
  });

  it('keeps the trail when the layout applied its own route first, on a section change', () => {
    // The layout starts from its own route, one level below the root that ResolveEnd gives.
    const created = applicationPage('app-1');
    TestBed.inject(RouteCrumbs).apply(created.root.firstChild as ActivatedRouteSnapshot);
    crumbs.set([{ label: 'storefront', raw: true }]);
    events.next(
      new ResolveEnd(2, '/a?section=domains', '/a?section=domains', applicationPage('app-1')),
    );
    expect(labels()).toEqual(['storefront']);
  });

  it("is the route's own again on another page", () => {
    events.next(new ResolveEnd(1, '/a', '/a', applicationPage('app-1')));
    crumbs.set([{ label: 'storefront', raw: true }]);
    events.next(new ResolveEnd(2, '/b', '/b', applicationPage('app-2')));
    expect(labels()).toEqual(['Applications']);
    events.next(
      new ResolveEnd(
        3,
        '/servers',
        '/servers',
        state([
          { path: '' },
          { path: 'orgs/:organizationId', params: { organizationId: 'org-1' } },
          { path: 'servers' },
        ]),
      ),
    );
    expect(labels()).toEqual([]);
  });
});
