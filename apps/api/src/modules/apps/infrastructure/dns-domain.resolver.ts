import { Resolver } from 'node:dns/promises';

import { Injectable } from '@nestjs/common';

import type { DomainResolver } from '../application/ports';

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA']);

/** Bounded A and AAAA lookups through the host's resolver; it never connects to the answers. */
@Injectable()
export class DnsDomainResolver implements DomainResolver {
  private readonly resolver = new Resolver({ timeout: 3000, tries: 1 });

  async addresses(hostname: string): Promise<readonly string[] | undefined> {
    const answers = await Promise.allSettled([
      this.resolver.resolve4(hostname),
      this.resolver.resolve6(hostname),
    ]);
    const addresses = answers.flatMap((answer) =>
      answer.status === 'fulfilled' ? answer.value : [],
    );
    if (addresses.length) return addresses;
    const notFound = answers.every(
      (answer) =>
        answer.status === 'rejected' &&
        NOT_FOUND.has((answer.reason as NodeJS.ErrnoException).code ?? ''),
    );
    return notFound ? [] : undefined;
  }
}
