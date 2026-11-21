import { inject, Injectable } from '@angular/core';

import { AccessApi, type Member } from './access-api';

/** Pages read per search: a bound on one click, never a silent end of the list. */
const PAGES = 10;

/** Who may receive ownership (issue #255): an active member who is already an admin. */
export function isTransferTarget(member: Member): boolean {
  return member.active && member.orgRole === 'admin';
}

export interface TransferTargetPage {
  readonly targets: readonly Member[];
  /** Where to continue when members remain unread; null once the last page is read. */
  readonly next: string | null;
}

@Injectable({ providedIn: 'root' })
export class TransferTargets {
  private readonly api = inject(AccessApi);

  /** Reads up to ten pages of members from `cursor`, keeping the eligible ones. */
  async find(organizationId: string, cursor: string | null = null): Promise<TransferTargetPage> {
    const targets: Member[] = [];
    let next = cursor;
    for (let page = 0; page < PAGES; page++) {
      const { items, nextCursor } = await this.api.members(organizationId, next ?? undefined);
      targets.push(...items.filter(isTransferTarget));
      next = nextCursor;
      if (!next) break;
    }
    return { targets, next };
  }
}
