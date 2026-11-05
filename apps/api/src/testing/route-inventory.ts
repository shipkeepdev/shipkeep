import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, type ModulesContainer, type Reflector } from '@nestjs/core';
import type { Permission } from '@shipkeep/domain';

import { API_TOKEN_ACCESS } from '../modules/identity/interface/api-token-access';
import { ROUTE_ACCESS, type RouteAccess } from '../modules/identity/interface/route-access';
import { ANONYMOUS } from '../platform/http/allow-anonymous';

export interface RouteRow {
  readonly method: string;
  /** Controller and handler paths joined, without the global `/api/v1` prefix. */
  readonly path: string;
  readonly anonymous: boolean;
  readonly access: RouteAccess | undefined;
  readonly bearer: Permission | undefined;
}

/** Every registered controller route with its declared access, sorted by path then method. */
export function routeInventory(modules: ModulesContainer, reflector: Reflector): RouteRow[] {
  const scanner = new MetadataScanner();
  const rows: RouteRow[] = [];
  for (const module of modules.values()) {
    for (const controller of module.controllers.values()) {
      const type = controller.metatype;
      if (!type) continue;
      const prototype = type.prototype as Record<string, unknown>;
      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function') continue;
        const method = reflector.get<RequestMethod | undefined>(METHOD_METADATA, handler);
        if (method === undefined) continue;
        const targets = [handler, type];
        rows.push({
          method: RequestMethod[method],
          path: join(
            String(reflector.get(PATH_METADATA, type)),
            String(reflector.get(PATH_METADATA, handler)),
          ),
          anonymous: reflector.getAllAndOverride<boolean | undefined>(ANONYMOUS, targets) === true,
          access: reflector.getAllAndOverride<RouteAccess | undefined>(ROUTE_ACCESS, targets),
          bearer: reflector.getAllAndOverride<Permission | undefined>(API_TOKEN_ACCESS, targets),
        });
      }
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function join(...parts: string[]): string {
  const path = parts
    .flatMap((part) => part.split('/'))
    .filter((part) => part !== '')
    .join('/');
  return `/${path}`;
}
