import { InvalidInputError, isTenantId } from '@shipkeep/domain';

import type { CatalogBounds, CatalogPage } from './catalog-store';

export function pagination(input: Partial<CatalogBounds>): CatalogBounds {
  const limit = input.limit ?? 100;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (input.cursor !== undefined && !isTenantId(input.cursor))
  )
    throw new InvalidInputError(
      'invalid_catalog_page',
      'Use a valid cursor and a limit between 1 and 100.',
    );
  return { limit, ...(input.cursor ? { cursor: input.cursor } : {}) };
}
export function page<T extends { readonly id: string }>(
  items: T[],
  bounds: CatalogBounds,
): CatalogPage<T> {
  return { items, nextCursor: items.length === bounds.limit ? (items.at(-1)?.id ?? null) : null };
}
