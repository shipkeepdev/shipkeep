import { inject, Injectable, signal } from '@angular/core';
import { type ConfigIssue, parseShipkeepConfig } from '@shipkeep/config-schema';

import { IdentityRequestError } from '../identity/identity-api';
import { MutationRunner } from '../identity/mutation-runner';

import {
  type Application,
  DeliveryApi,
  type EnvironmentRef,
  type RepositoryConfig,
  type RepositoryConfigPreview,
  type WrittenConfigChange,
} from './delivery-api';

/**
 * A Git application's shipkeep.yml, edited here and written to its repository (#214): the
 * repository's file is the draft's start, a review previews the exact text written, and writing
 * opens a pull request or commits, as the project says. Component-scoped.
 */
@Injectable()
export class RepositoryConfigStore {
  private readonly api = inject(DeliveryApi);
  readonly runner = inject(MutationRunner);
  private environment: EnvironmentRef | undefined;
  private application: Application | undefined;
  private revision = 0;
  /** The file as the repository held it when last read. */
  readonly file = signal<RepositoryConfig | null>(null);
  /** The last read failed: what was read before stays. */
  readonly unread = signal(false);
  readonly draft = signal('');
  readonly issues = signal<readonly ConfigIssue[]>([]);
  /** What writing the reviewed draft would change, and the document it was made from. */
  readonly preview = signal<RepositoryConfigPreview | null>(null);
  private reviewed: object | null = null;
  readonly written = signal<WrittenConfigChange | null>(null);
  /** The file changed in the repository since the draft was made against it. */
  readonly conflict = signal(false);
  readonly notice = signal<string | null>(null);

  async open(environment: EnvironmentRef, application: Application): Promise<void> {
    this.runner.reset();
    this.environment = environment;
    this.application = application;
    this.file.set(null);
    this.draft.set('');
    this.clear();
    this.written.set(null);
    this.conflict.set(false);
    await this.load(true);
  }

  /** Reads the file; the draft starts from it only when asked, so that edits are never lost. */
  async load(replaceDraft = false): Promise<void> {
    const environment = this.environment;
    const application = this.application;
    if (!environment || !application) return;
    const revision = ++this.revision;
    try {
      const file = await this.api.repositoryConfig(environment, application.id);
      if (revision !== this.revision) return;
      this.file.set(file);
      if (replaceDraft) this.draft.set(file.text);
      this.unread.set(false);
    } catch {
      if (revision === this.revision) this.unread.set(true);
    }
  }

  edit(value: string): void {
    if (this.runner.busy()) return;
    this.draft.set(value);
    this.clear();
  }

  /** Checks the draft here, then asks the control plane for the exact text it would write. */
  async review(): Promise<void> {
    const environment = this.environment;
    const application = this.application;
    const file = this.file();
    if (!environment || !application || !file || this.runner.busy() || this.conflict()) return;
    this.runner.reset();
    this.clear();
    this.written.set(null);
    const parsed = parseShipkeepConfig(this.draft());
    if (!parsed.ok) {
      this.issues.set(parsed.issues.slice(0, 20));
      return;
    }
    if (parsed.config.name !== application.name) {
      this.issues.set([{ path: '/name', message: 'The application name cannot be changed.' }]);
      return;
    }
    const document = parsed.config;
    const outcome = await this.runner.run(
      { review: application.id, blob: file.blobSha, draft: this.draft() },
      (_, isCurrent) =>
        this.conflicted(isCurrent, () =>
          this.api.previewRepositoryConfig(environment, application.id, document, file.blobSha),
        ),
    );
    if (!outcome.ok || !outcome.value) return;
    if (!outcome.value.diff.length) {
      this.notice.set('This draft leaves the file as it is: there is nothing to write.');
      return;
    }
    this.reviewed = document;
    this.preview.set(outcome.value);
  }

  /** Writes the change reviewed, against the very text it was previewed on. */
  async write(): Promise<void> {
    const environment = this.environment;
    const application = this.application;
    const preview = this.preview();
    const document = this.reviewed;
    if (!environment || !application || !preview || !document || this.conflict()) return;
    const outcome = await this.runner.run(
      { write: application.id, blob: preview.blobSha, text: preview.changedText },
      (_, isCurrent) =>
        this.conflicted(isCurrent, () =>
          this.api.changeRepositoryConfig(environment, application.id, document, preview.blobSha),
        ),
    );
    if (!outcome.ok || !outcome.value) return;
    this.written.set(outcome.value);
    this.clear();
    // The change is in the repository now, on the branch or in its pull request: the draft starts
    // again from the branch's file, so that it is not written twice.
    await this.load(true);
  }

  /** Leaves the review: the draft stays as it was, to edit further. */
  back(): void {
    if (this.runner.busy()) return;
    this.clear();
  }

  /** After a conflict: reads the file again, and keeps the draft to review against it. */
  async reload(): Promise<void> {
    if (this.runner.busy()) return;
    this.runner.reset();
    this.clear();
    await this.load(false);
    if (this.unread()) return;
    this.conflict.set(false);
    this.notice.set('The latest file is loaded. Your draft is unchanged: review it again.');
  }

  private clear(): void {
    this.issues.set([]);
    this.preview.set(null);
    this.reviewed = null;
    this.notice.set(null);
  }

  /** A file changed in the repository is a conflict to resolve, not a failure to report. */
  private async conflicted<T>(
    isCurrent: () => boolean,
    call: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await call();
    } catch (error: unknown) {
      if (
        error instanceof IdentityRequestError &&
        error.status === 409 &&
        error.problem?.code === 'config_file_changed'
      ) {
        if (isCurrent()) this.conflict.set(true);
        return undefined;
      }
      throw error;
    }
  }
}
