import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { AppConfig } from '../../../platform/config/app-config';
import { REGISTRY_TOKEN_KEY, type RegistryTokenKeyProvider } from '../../fleet/application/ports';
import { MAX_REGISTRY_TAGS, REGISTRY_SERVICE, type RegistryStorage } from '../application/ports';
import {
  compactToken,
  REGISTRY_TOKEN_SECONDS,
  RETENTION_SUBJECT,
  retentionAccess,
  signingInput,
  tokenClaims,
} from '../domain/registry-token';

/** A repository name as Distribution writes it: lower-case path components. */
const REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*){0,4}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const TIMEOUT_MS = 10_000;
/** The largest answer read: a page of names. */
const MAX_ANSWER = 1 << 20;
const TAG_PAGE = 1000;

/**
 * The installation's registry over its HTTP API (ADR 0030), on the Compose network, with tokens
 * the control plane signs for itself: the catalog, and pull and delete on one repository at a
 * time. Names are checked before they go into a URL. A list ends with an empty page: the API may
 * answer a short one before the end.
 */
@Injectable()
export class DistributionStorage implements RegistryStorage {
  private readonly base: string;

  constructor(
    config: AppConfig,
    @Inject(REGISTRY_TOKEN_KEY) private readonly keys: RegistryTokenKeyProvider,
    @Inject(REGISTRY_SERVICE) private readonly service: string,
  ) {
    this.base = config.get('REGISTRY_URL').replace(/\/+$/, '');
  }

  async repositories(last: string | undefined, limit: number): Promise<string[]> {
    const query = new URLSearchParams({ n: String(limit) });
    if (last !== undefined) query.set('last', last);
    const answer = await this.call('GET', `/v2/_catalog?${query.toString()}`, undefined);
    const names = (answer.body as { repositories?: unknown } | undefined)?.repositories;
    return Array.isArray(names)
      ? names.filter((name): name is string => typeof name === 'string')
      : [];
  }

  async tags(repository: string): Promise<string[]> {
    named(repository);
    const tags: string[] = [];
    let last: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ n: String(TAG_PAGE) });
      if (last !== undefined) query.set('last', last);
      const answer = await this.call(
        'GET',
        `/v2/${repository}/tags/list?${query.toString()}`,
        repository,
      );
      if (answer.status === 404) break;
      const page = (answer.body as { tags?: unknown } | undefined)?.tags;
      if (!Array.isArray(page) || page.length === 0) break;
      tags.push(...page.filter((tag): tag is string => typeof tag === 'string' && TAG.test(tag)));
      if (tags.length > MAX_REGISTRY_TAGS) throw new Error('the repository has too many tags');
      const next: unknown = page.at(-1);
      // A page that does not move past the last one would repeat forever.
      if (typeof next !== 'string' || next === last)
        throw new Error('the registry repeated a page');
      last = next;
    }
    return tags;
  }

  async deleteTag(repository: string, tag: string): Promise<boolean> {
    named(repository);
    if (!TAG.test(tag)) throw new Error('not a tag');
    const answer = await this.call('DELETE', `/v2/${repository}/manifests/${tag}`, repository);
    return answer.status !== 404;
  }

  /**
   * One call with a token for the catalog, or for one repository. 404 is an answer; any other
   * status outside 2xx throws, without the registry's text.
   */
  private async call(
    method: 'GET' | 'DELETE',
    path: string,
    repository: string | undefined,
  ): Promise<{ status: number; body?: unknown }> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      redirect: 'error',
      headers: { authorization: `Bearer ${await this.token(repository)}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const status = response.status;
    if (status === 404) {
      await response.body?.cancel();
      return { status };
    }
    if (status < 200 || status >= 300) {
      await response.body?.cancel();
      throw new Error(`the registry answered ${String(status)}`);
    }
    if (method !== 'GET') {
      await response.body?.cancel();
      return { status };
    }
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MAX_ANSWER) {
      await response.body?.cancel();
      throw new Error('the registry answered too much');
    }
    const text = await response.text();
    if (text.length > MAX_ANSWER) throw new Error('the registry answered too much');
    return { status, body: JSON.parse(text) as unknown };
  }

  /** A token of the control plane's own, for five minutes at most. */
  private async token(repository: string | undefined): Promise<string> {
    const now = new Date();
    const key = await this.keys.registryKey();
    const claims = tokenClaims({
      service: this.service,
      subject: RETENTION_SUBJECT,
      access: retentionAccess(repository),
      id: uuidv7(),
      now,
      grantExpiresAt: new Date(now.getTime() + REGISTRY_TOKEN_SECONDS * 1000),
    });
    const input = signingInput(key.keyId, claims);
    const signature = await this.keys.signRegistryToken(Buffer.from(input, 'utf8'));
    return compactToken(input, signature);
  }
}

function named(repository: string): void {
  if (!REPOSITORY.test(repository) || repository.length > 255) throw new Error('not a repository');
}
