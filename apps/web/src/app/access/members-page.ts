import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidatorFn,
  Validators,
} from '@angular/forms';
import { RouterLink } from '@angular/router';

import { required } from '../workspace/validators';

import { AccessApi, type Member, type OrganizationRole, type Proof } from './access-api';
import { PagedList } from './paged-list';
import { ReauthForm, reauthControls } from './reauth-form';

const email: ValidatorFn = (control) => Validators.email(control);

/** Organization members: adding existing accounts, changing roles and removing (SPEC 7). */
@Component({
  selector: 'sk-members-page',
  imports: [ReactiveFormsModule, RouterLink, ReauthForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav aria-label="Breadcrumb" class="mb-4 text-sm">
      <a routerLink="/orgs">Organizations</a> /
      <a [routerLink]="['/orgs', organizationId()]">Organization</a>
    </nav>
    <section class="max-w-3xl" aria-labelledby="members-title">
      <h1 id="members-title">Members</h1>
      <p class="page-intro">
        Changing a role or removing someone ends their sessions and invalidates their API tokens.
      </p>
      @if (notice(); as text) {
        <p role="status" class="feedback">{{ text }}</p>
      }
      @if (members.problem(); as problem) {
        <div class="feedback" role="alert">
          <p>{{ problem }}</p>
        </div>
      }
      @switch (members.state()) {
        @case ('loading') {
          <p role="status" class="text-muted">Loading members…</p>
        }
        @case ('ready') {
          <ul class="mb-8 divide-y divide-line border-y border-line" aria-label="Members">
            @for (member of members.items(); track member.id) {
              <li class="py-3">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    <span class="break-all">{{ member.email }}</span>
                    <span class="ml-2 text-sm text-muted">{{ member.orgRole }}</span>
                    @if (!member.active) {
                      <span class="ml-2 text-sm text-muted">disabled</span>
                    }
                  </span>
                  <span class="flex gap-2">
                    <button
                      class="button button-secondary"
                      type="button"
                      (click)="select(member, 'role')"
                    >
                      Change role
                    </button>
                    <button
                      class="button button-secondary"
                      type="button"
                      (click)="select(member, 'remove')"
                    >
                      Remove
                    </button>
                  </span>
                </div>
                @if (selected()?.member?.id === member.id) {
                  @if (selected()?.mode === 'role') {
                    <div class="mt-4">
                      <sk-reauth-form
                        prefix="member-role"
                        label="Change role"
                        [form]="roleForm"
                        [send]="changeRole"
                        (done)="finished('Role changed.')"
                      >
                        <div>
                          <label for="member-role-role">New role</label>
                          <select id="member-role-role" [formControl]="roleForm.controls.role">
                            @for (role of roles; track role) {
                              <option [value]="role">{{ role }}</option>
                            }
                          </select>
                        </div>
                        <button
                          secondary
                          class="button button-secondary"
                          type="button"
                          (click)="selected.set(null)"
                        >
                          Cancel
                        </button>
                      </sk-reauth-form>
                    </div>
                  } @else {
                    <div class="mt-4">
                      <p class="hint">
                        This removes {{ member.email }} from the organization and from every project
                        and environment. An organization always keeps one owner.
                      </p>
                      <sk-reauth-form
                        prefix="member-remove"
                        label="Remove member"
                        [form]="removeForm"
                        [send]="removeMember"
                        (done)="finished('Member removed.')"
                      >
                        <button
                          secondary
                          class="button button-secondary"
                          type="button"
                          (click)="selected.set(null)"
                        >
                          Cancel
                        </button>
                      </sk-reauth-form>
                    </div>
                  }
                }
              </li>
            }
          </ul>
          @if (members.hasMore()) {
            <div class="mb-8">
              <button
                class="button button-secondary"
                type="button"
                [disabled]="members.loadingMore()"
                (click)="members.more()"
              >
                {{ members.loadingMore() ? 'Loading…' : 'Show more members' }}
              </button>
            </div>
          }
        }
      }
      <section aria-labelledby="add-member-title" class="border-t border-line pt-6">
        <h2 id="add-member-title">Add a member</h2>
        <p class="hint">The account must already exist and have a verified email.</p>
        <sk-reauth-form
          prefix="member-add"
          label="Add member"
          [form]="addForm"
          [send]="addMember"
          (done)="added()"
        >
          <div>
            <label for="member-add-email">Email</label>
            <input
              id="member-add-email"
              type="email"
              [formControl]="addForm.controls.email"
              maxlength="254"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <div>
            <label for="member-add-role">Role</label>
            <select id="member-add-role" [formControl]="addForm.controls.role">
              @for (role of roles; track role) {
                <option [value]="role">{{ role }}</option>
              }
            </select>
          </div>
        </sk-reauth-form>
      </section>
    </section>
  `,
})
export class MembersPage {
  private readonly api = inject(AccessApi);
  readonly organizationId = input.required<string>();
  protected readonly roles: readonly OrganizationRole[] = ['member', 'admin', 'owner'];
  protected readonly members = new PagedList<Member>((cursor) =>
    this.api.members(this.organizationId(), cursor),
  );
  protected readonly selected = signal<{ member: Member; mode: 'role' | 'remove' } | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly addForm = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [required, email] }),
    role: new FormControl<OrganizationRole>('member', { nonNullable: true }),
    ...reauthControls(),
  });
  protected readonly roleForm = new FormGroup({
    role: new FormControl<OrganizationRole>('member', { nonNullable: true }),
    ...reauthControls(),
  });
  protected readonly removeForm = new FormGroup(reauthControls());

  protected readonly addMember = (proof: Proof, key: string): Promise<void> => {
    const { email, role } = this.addForm.getRawValue();
    return this.api.addMember(this.organizationId(), { email, role, ...proof }, key);
  };
  protected readonly changeRole = (proof: Proof, key: string): Promise<void> => {
    const { role } = this.roleForm.getRawValue();
    return this.api.changeRole(this.organizationId(), this.targetId(), { role, ...proof }, key);
  };
  protected readonly removeMember = (proof: Proof, key: string): Promise<void> =>
    this.api.removeMember(this.organizationId(), this.targetId(), proof, key);

  constructor() {
    effect(() => {
      this.organizationId();
      this.selected.set(null);
      this.notice.set(null);
      void this.members.refresh();
    });
  }

  protected select(member: Member, mode: 'role' | 'remove'): void {
    this.notice.set(null);
    this.roleForm.reset({ role: member.orgRole });
    this.removeForm.reset();
    this.selected.set({ member, mode });
  }
  protected finished(notice: string): void {
    this.selected.set(null);
    this.notice.set(notice);
    void this.members.refresh();
  }
  protected added(): void {
    this.addForm.reset();
    this.finished('Member added.');
  }

  private targetId(): string {
    const target = this.selected();
    if (!target) throw new Error('No member is selected.');
    return target.member.id;
  }
}
