import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AccessApi, type Member, type Proof } from '../access/access-api';
import { ReauthForm, reauthControls } from '../access/reauth-form';
import { type TransferTargetPage, TransferTargets } from '../access/transfer-targets';
import { T } from '../ui/i18n';

import { ShellContext } from '../shell/shell-context';

/**
 * The organization's danger zone (issue #255). An owner hands ownership to another admin under a
 * fresh password and second factor: the admin becomes an owner and the caller an admin. Deleting
 * the organization is not built yet and says so.
 */
@Component({
  selector: 'sk-organization-danger',
  imports: [ReactiveFormsModule, ReauthForm, RouterLink, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-3.5' },
  template: `
    @if (notice(); as text) {
      <p class="alert alert-ok" role="status">{{ text | t }}</p>
    }
    <div class="overflow-hidden rounded-2xl border border-[rgb(255_92_92/35%)] bg-black">
      <div class="flex items-center justify-between gap-4 px-5 py-4 max-sm:flex-wrap">
        <div>
          <div class="text-[13.5px]">{{ 'Transfer ownership' | t }}</div>
          <div class="mt-[3px] text-[12px] text-mute2">
            {{
              (owner()
                ? 'Another admin becomes an owner, and you become an admin.'
                : 'Only an owner can hand over ownership.'
              ) | t
            }}
          </div>
        </div>
        @if (!open()) {
          <button
            class="btn btn-danger"
            type="button"
            [disabled]="!owner()"
            (click)="open.set(true)"
          >
            {{ 'Transfer' | t }}
          </button>
        }
      </div>
      @if (open()) {
        <div class="border-t border-line2 bg-[#0a0a0b] px-5 py-4">
          @if (failed()) {
            <div class="alert mb-3" role="alert">
              {{ 'The members could not be read. Try again.' | t }}
            </div>
            <button class="btn btn-sm" type="button" (click)="close()">{{ 'Cancel' | t }}</button>
          } @else if (admins() === null) {
            <p class="text-[13px] text-mute2">{{ 'Loading…' | t }}</p>
          } @else if (admins()?.length === 0) {
            <p class="mb-3 text-[13px] text-fg3">
              {{
                (more()
                  ? 'No active admin among the members read so far.'
                  : 'Ownership goes to an admin. Make a member an admin first.'
                ) | t
              }}
            </p>
            <div class="flex flex-wrap gap-2.5">
              @if (more(); as cursor) {
                <button class="btn btn-sm" type="button" (click)="load(cursor)">
                  {{ 'Read more members' | t }}
                </button>
              }
              <a class="btn btn-sm" [routerLink]="['/orgs', organizationId(), 'members']">{{
                'Members & access' | t
              }}</a>
              <button class="btn btn-sm" type="button" (click)="close()">
                {{ 'Cancel' | t }}
              </button>
            </div>
          } @else {
            <sk-reauth-form
              prefix="transfer-ownership"
              [label]="'Transfer ownership' | t"
              [form]="form"
              [send]="transfer"
              (done)="transferred()"
            >
              <div class="flex max-w-[320px] flex-col gap-1.5">
                <label for="transfer-ownership-target" class="text-[12px] text-fg3">{{
                  'New owner' | t
                }}</label>
                <select
                  id="transfer-ownership-target"
                  class="input"
                  [formControl]="form.controls.target"
                >
                  @for (admin of admins(); track admin.id) {
                    <option [value]="admin.id">
                      {{
                        admin.displayName ? admin.displayName + ' · ' + admin.email : admin.email
                      }}
                    </option>
                  }
                </select>
                @if (more(); as cursor) {
                  <button class="btn btn-sm self-start" type="button" (click)="load(cursor)">
                    {{ 'Read more members' | t }}
                  </button>
                }
              </div>
              <p class="text-[12px] text-mute2">
                {{
                  'You keep administering the organization. Your session is renewed, and theirs ends: they sign in again as an owner.'
                    | t
                }}
              </p>
              <button secondary class="btn btn-sm" type="button" (click)="close()">
                {{ 'Cancel' | t }}
              </button>
            </sk-reauth-form>
          }
        </div>
      }
      <div
        class="flex items-center justify-between gap-4 border-t border-line2 px-5 py-4 max-sm:flex-wrap"
      >
        <div>
          <div class="text-[13.5px]">{{ 'Delete the organization' | t }}</div>
          <div class="mt-[3px] text-[12px] text-mute2">
            {{ 'Deleting an organization is not available yet.' | t }}
          </div>
        </div>
        <button class="btn btn-danger" type="button" disabled>{{ 'Delete' | t }}</button>
      </div>
    </div>
  `,
})
export class OrganizationDanger {
  private readonly targets = inject(TransferTargets);
  private readonly api = inject(AccessApi);
  private readonly shell = inject(ShellContext);
  readonly organizationId = input.required<string>();
  protected readonly owner = computed(() => this.shell.role() === 'owner');
  protected readonly open = signal(false);
  protected readonly notice = signal<string | null>(null);
  /** Null while loading. */
  protected readonly admins = signal<readonly Member[] | null>(null);
  protected readonly failed = signal(false);
  /** Where the member search continues; null once every member was read. */
  protected readonly more = signal<string | null>(null);
  protected readonly form = new FormGroup({
    target: new FormControl('', {
      nonNullable: true,
      validators: [(control) => Validators.required(control)],
    }),
    ...reauthControls(),
  });
  #revision = 0;

  constructor() {
    effect(() => {
      this.organizationId();
      this.close();
      this.notice.set(null);
    });
    effect(() => {
      if (this.open()) void this.load();
    });
  }

  protected readonly transfer = (proof: Proof, key: string): Promise<void> =>
    this.api.transferOwnership(this.organizationId(), this.form.controls.target.value, proof, key);

  protected close(): void {
    this.#revision++;
    // A cancelled password or code must not wait in the form for the next opening.
    this.form.controls.password.reset('');
    this.form.controls.code.reset('');
    this.open.set(false);
    this.admins.set(null);
    this.more.set(null);
    this.form.controls.target.setValue('');
    this.failed.set(false);
  }

  protected transferred(): void {
    this.close();
    this.notice.set('Ownership transferred. You are now an admin.');
    void this.shell.refresh();
  }

  /** Reads members from `cursor` on; a later page adds to the admins found so far. */
  protected async load(cursor: string | null = null): Promise<void> {
    const revision = ++this.#revision;
    this.failed.set(false);
    let page: TransferTargetPage;
    try {
      page = await this.targets.find(this.organizationId(), cursor);
    } catch {
      if (revision === this.#revision) this.failed.set(true);
      return;
    }
    if (revision !== this.#revision) return;
    const found = [...(cursor ? (this.admins() ?? []) : []), ...page.targets];
    this.admins.set(found);
    this.more.set(page.next);
    if (!this.form.controls.target.value) this.form.controls.target.setValue(found.at(0)?.id ?? '');
  }
}
