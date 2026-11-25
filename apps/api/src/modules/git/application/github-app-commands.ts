import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, createEvent, type Permission } from '@shipkeep/domain';

import { AppConfig } from '../../../platform/config/app-config';
import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import {
  resourceActor,
  type ResourceSecurityContext as SecurityContext,
} from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import {
  createdGithubApp,
  flowInvalid,
  GITHUB_APP_FLOW_MS,
  githubAppCreationUrl,
  githubAppManifest,
  type GithubAppMetadata,
  githubAppName,
  githubManifestCode,
} from '../domain/github-app';

import {
  GIT_TRANSACTION,
  GITHUB_APP_STORE,
  GITHUB_MANIFESTS,
  type GitTransaction,
  type GithubAppStore,
  type GithubManifests,
} from './ports';

/** Only an owner connects a Git provider: the App can write to the organization's repositories. */
const MANAGE: Exclude<Permission, 'profile.read'> = 'integration.manage';
const READ: Exclude<Permission, 'profile.read'> = 'organization.read';
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Where the owner's browser posts the manifest, and the manifest itself. */
export interface GithubAppCreation {
  readonly url: string;
  readonly manifest: string;
}

/**
 * The GitHub App of an organization, made with GitHub's manifest flow (ADR 0031). An owner starts
 * the flow; GitHub creates the App and sends the owner back with a code, which the control plane
 * exchanges for the App and its secrets. The state that ties the two halves is random, stored
 * hashed, bound to the owner and valid for an hour.
 */
@Injectable()
export class GithubAppCommands {
  constructor(
    @Inject(GITHUB_APP_STORE) private readonly store: GithubAppStore,
    @Inject(GITHUB_MANIFESTS) private readonly manifests: GithubManifests,
    @Inject(GIT_TRANSACTION) private readonly transaction: GitTransaction,
    private readonly config: AppConfig,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly events: DomainEventBus,
  ) {}

  /** The App connected to the organization, or undefined. */
  find(context: SecurityContext, organizationId: string): Promise<GithubAppMetadata | undefined> {
    return this.scoped(context, organizationId, READ, () => this.store.find(organizationId));
  }

  /** Starts the flow: GitHub then creates the App on the owner's account or GitHub organization. */
  start(
    context: SecurityContext,
    organizationId: string,
    input: { githubOrganization?: string | undefined },
    now = new Date(),
  ): Promise<GithubAppCreation> {
    const state = randomBytes(32).toString('base64url');
    const url = githubAppCreationUrl(state, input.githubOrganization);
    return this.scoped(context, organizationId, MANAGE, async () => {
      if (await this.store.find(organizationId)) throw appExists();
      const name = githubAppName(await this.store.organizationSlug(organizationId), suffix());
      const manifest = githubAppManifest({
        name,
        publicUrl: this.config.get('API_PUBLIC_URL'),
        organizationId,
      });
      await this.store.startFlow(organizationId, {
        stateHash: hash(state),
        userId: context.userId,
        expiresAt: new Date(now.getTime() + GITHUB_APP_FLOW_MS),
      });
      await this.events.publish([
        createEvent({
          type: 'github.app_flow_started',
          organizationId,
          actor: resourceActor(context),
          target: { type: 'organization', id: organizationId },
          payload: { name, githubOrganization: input.githubOrganization ?? null },
          occurredAt: now,
        }),
      ]);
      return { url, manifest: JSON.stringify(manifest) };
    });
  }

  /**
   * Completes the flow with the code GitHub sent the owner back with. The state is checked before
   * GitHub is asked anything, and again when the App is stored, so that one flow stores one App.
   */
  async complete(
    context: SecurityContext,
    organizationId: string,
    input: { code: string; state: string },
    now = new Date(),
  ): Promise<GithubAppMetadata> {
    githubManifestCode(input.code, input.state);
    const stateHash = hash(input.state);
    await this.scoped(context, organizationId, MANAGE, async () => {
      if (await this.store.find(organizationId)) throw appExists();
      const flow = await this.store.flow(organizationId);
      if (
        !flow ||
        flow.userId !== context.userId ||
        flow.expiresAt.getTime() <= now.getTime() ||
        !sameHash(flow.stateHash, stateHash)
      )
        throw flowInvalid();
    });
    // GitHub's code is single use and lasts an hour; it is exchanged outside any transaction.
    const app = createdGithubApp(await this.manifests.convert(input.code));
    return this.scoped(context, organizationId, MANAGE, async () => {
      const stored = await this.store.create(organizationId, stateHash, app, context.userId, now);
      if (!stored) throw flowInvalid();
      await this.events.publish([
        createEvent({
          type: 'github.app_created',
          organizationId,
          actor: resourceActor(context),
          target: { type: 'github_app', id: String(stored.appId) },
          // Never a secret: the App's identity and where it lives.
          payload: {
            appId: stored.appId,
            slug: stored.slug,
            name: stored.name,
            ownerLogin: stored.ownerLogin,
          },
          occurredAt: now,
        }),
      ]);
      return stored;
    });
  }

  private scoped<T>(
    context: SecurityContext,
    organizationId: string,
    permission: Exclude<Permission, 'profile.read'>,
    work: () => Promise<T>,
  ): Promise<T> {
    const scope = { organizationId };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, permission, scope);
        return this.transaction.runTenant(organizationId, work);
      },
      { permission, target: scope },
    );
  }
}

function appExists(): ConflictError {
  return new ConflictError('github_app_exists', 'This organization already has a GitHub App.');
}

function hash(state: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(state, 'utf8').digest());
}

function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function suffix(): string {
  let value = '';
  for (let i = 0; i < 6; i++) value += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)];
  return value;
}
