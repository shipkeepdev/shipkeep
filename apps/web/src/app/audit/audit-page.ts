import { DatePipe, DOCUMENT, JsonPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidatorFn,
  Validators,
} from '@angular/forms';
import { RouterLink } from '@angular/router';

import type { AuditEvent, AuditQuery } from './audit-api';
import { AuditLogStore } from './audit-log-store';

// The same patterns as the API, so a filter it would refuse is explained here instead.
const IDENTIFIER = /^[A-Za-z0-9._:/-]{1,128}$/;
const FILTERS = [
  {
    name: 'action',
    label: 'Action',
    hint: 'Exact name, such as deployment.created.',
    pattern: /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    maxLength: 128,
  },
  {
    name: 'targetType',
    label: 'Target type',
    hint: 'Lowercase, such as application.',
    pattern: /^[a-z][a-z0-9_]{0,63}$/,
    maxLength: 64,
  },
  {
    name: 'targetId',
    label: 'Target ID',
    hint: 'Exact ID.',
    pattern: IDENTIFIER,
    maxLength: 128,
  },
  {
    name: 'actorId',
    label: 'Actor ID',
    hint: 'Exact ID.',
    pattern: IDENTIFIER,
    maxLength: 128,
  },
] as const;

const isoTime = (local: string): string | undefined => {
  const time = new Date(local);
  return local && !Number.isNaN(time.getTime()) ? time.toISOString() : undefined;
};
const validTime: ValidatorFn = (control) =>
  !control.value || isoTime(String(control.value)) ? null : { time: true };
const orderedPeriod: ValidatorFn = (group) => {
  const { from, to } = (group as AuditFilterForm).getRawValue();
  const [start, end] = [isoTime(from), isoTime(to)];
  return start && end && start >= end ? { period: true } : null;
};

type AuditFilterForm = ReturnType<typeof filterForm>;
function filterForm() {
  const text = (pattern: RegExp) =>
    new FormControl('', { nonNullable: true, validators: [Validators.pattern(pattern)] });
  return new FormGroup(
    {
      action: text(FILTERS[0].pattern),
      targetType: text(FILTERS[1].pattern),
      targetId: text(FILTERS[2].pattern),
      actorId: text(FILTERS[3].pattern),
      from: new FormControl('', { nonNullable: true, validators: [validTime] }),
      to: new FormControl('', { nonNullable: true, validators: [validTime] }),
    },
    { validators: [orderedPeriod] },
  );
}

/** Reading an organization's audit log (PLAN M2.4b); reads are not themselves audited. */
@Component({
  selector: 'sk-audit-page',
  imports: [DatePipe, JsonPipe, ReactiveFormsModule, RouterLink],
  providers: [AuditLogStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav aria-label="Breadcrumb" class="mb-4 text-sm">
      <a routerLink="/orgs">Organizations</a> /
      <a [routerLink]="['/orgs', organizationId()]">Organization</a>
    </nav>
    <section aria-labelledby="audit-title">
      <h1 id="audit-title">Audit log</h1>
      <p class="page-intro">Every change in this organization, newest first.</p>
      <form
        [formGroup]="form"
        (ngSubmit)="apply()"
        class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        aria-label="Filter audit events"
      >
        @for (filter of filters; track filter.name) {
          <div>
            <label [for]="'audit-' + filter.name">{{ filter.label }}</label>
            <input
              [id]="'audit-' + filter.name"
              [formControlName]="filter.name"
              [attr.maxlength]="filter.maxLength"
              [attr.aria-describedby]="'audit-' + filter.name + '-hint'"
              [attr.aria-invalid]="form.controls[filter.name].invalid"
              autocomplete="off"
              spellcheck="false"
            />
            <p
              [id]="'audit-' + filter.name + '-hint'"
              [class]="form.controls[filter.name].invalid ? 'field-error' : 'hint'"
            >
              {{ filter.hint }}
            </p>
          </div>
        }
        <div>
          <label for="audit-from">From (your local time)</label>
          <input id="audit-from" type="datetime-local" formControlName="from" />
        </div>
        <div>
          <label for="audit-to">Before (your local time)</label>
          <input
            id="audit-to"
            type="datetime-local"
            formControlName="to"
            aria-describedby="audit-period-error"
            [attr.aria-invalid]="form.hasError('period')"
          />
          @if (form.hasError('period')) {
            <p id="audit-period-error" class="field-error">This must be after the start.</p>
          }
        </div>
        <div class="flex flex-wrap items-end gap-3 sm:col-span-2 lg:col-span-3">
          <button class="button" type="submit" [disabled]="form.invalid">Apply filters</button>
          <button class="button button-secondary" type="button" (click)="clear()">Clear</button>
          <button
            class="button button-secondary"
            type="button"
            [disabled]="store.exporting()"
            (click)="export()"
          >
            {{ store.exporting() ? 'Exporting…' : 'Export as JSON Lines' }}
          </button>
        </div>
      </form>
      @if (store.exportProblem(); as problem) {
        <div class="feedback" role="alert">
          <p>{{ problem }}</p>
        </div>
      }
      @if (truncated()) {
        <p role="status" class="feedback">
          The export holds the most recent 10,000 events. Narrow the period to export older ones.
        </p>
      }
      @if (store.problem(); as problem) {
        <div class="feedback" role="alert">
          <p>{{ problem }}</p>
        </div>
      }
      @switch (store.state()) {
        @case ('loading') {
          <p role="status" class="text-muted">Loading events…</p>
        }
        @case ('ready') {
          @if (store.events().length) {
            <div class="overflow-x-auto" tabindex="0" role="region" aria-label="Audit events">
              <table class="w-full text-left text-sm" aria-label="Audit events">
                <thead>
                  <tr class="border-b border-line">
                    <th scope="col" class="py-2 pr-4">Time</th>
                    <th scope="col" class="py-2 pr-4">Action</th>
                    <th scope="col" class="py-2 pr-4">Actor</th>
                    <th scope="col" class="py-2 pr-4">Target</th>
                    <th scope="col" class="py-2 pr-4">IP</th>
                    <th scope="col" class="py-2">Details</th>
                  </tr>
                </thead>
                <tbody>
                  @for (event of store.events(); track event.id) {
                    <tr class="border-b border-line align-top">
                      <td class="py-2 pr-4 whitespace-nowrap tabular-nums">
                        <time [attr.datetime]="event.createdAt">{{
                          event.createdAt | date: 'yyyy-MM-dd HH:mm:ss'
                        }}</time>
                      </td>
                      <td class="py-2 pr-4">
                        <code>{{ event.action }}</code>
                      </td>
                      <td class="py-2 pr-4">
                        {{ event.actorKind }}
                        @if (event.actorId; as actor) {
                          <code class="block break-all">{{ actor }}</code>
                        }
                      </td>
                      <td class="py-2 pr-4">
                        {{ event.targetType }}
                        <code class="block break-all">{{ event.targetId }}</code>
                      </td>
                      <td class="py-2 pr-4">{{ event.ip ?? '—' }}</td>
                      <td class="py-2">
                        @if (hasDetails(event)) {
                          <details>
                            <summary>Show</summary>
                            <pre class="mt-2 max-w-md overflow-x-auto" tabindex="0">{{
                              event.metadata | json
                            }}</pre>
                          </details>
                        } @else {
                          —
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (store.hasMore()) {
              <div class="mt-4">
                <button
                  class="button button-secondary"
                  type="button"
                  [disabled]="store.loadingMore()"
                  (click)="store.more()"
                >
                  {{ store.loadingMore() ? 'Loading…' : 'Load older events' }}
                </button>
              </div>
            }
          } @else {
            <p class="border-y border-line py-6 text-muted">
              {{
                filtered()
                  ? 'No events match these filters.'
                  : 'Nothing has been recorded in this organization yet.'
              }}
            </p>
          }
        }
      }
    </section>
  `,
})
export class AuditPage {
  private readonly document = inject(DOCUMENT);
  protected readonly store = inject(AuditLogStore);
  readonly organizationId = input.required<string>();
  protected readonly filters = FILTERS;
  protected readonly form = filterForm();
  protected readonly truncated = signal(false);

  constructor() {
    effect(() => {
      const id = this.organizationId();
      this.form.reset();
      this.truncated.set(false);
      void this.store.open(id, {});
    });
  }

  protected filtered(): boolean {
    return Object.keys(this.store.query()).length > 0;
  }
  protected hasDetails(event: AuditEvent): boolean {
    return Object.keys(event.metadata).length > 0;
  }

  protected apply(): void {
    if (this.form.invalid) return;
    this.truncated.set(false);
    void this.store.open(this.organizationId(), this.selection());
  }
  protected clear(): void {
    this.form.reset();
    this.truncated.set(false);
    void this.store.open(this.organizationId(), {});
  }

  protected async export(): Promise<void> {
    const result = await this.store.export();
    if (!result) return;
    this.truncated.set(result.truncated);
    this.save(result.text);
  }

  private selection(): AuditQuery {
    const { from, to, ...identifiers } = this.form.getRawValue();
    const start = isoTime(from);
    const end = isoTime(to);
    return {
      ...Object.fromEntries(Object.entries(identifiers).filter(([, value]) => value)),
      ...(start ? { from: start } : {}),
      ...(end ? { to: end } : {}),
    };
  }

  private save(text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
    const link = this.document.createElement('a');
    link.href = url;
    link.download = `audit-${this.organizationId()}.jsonl`;
    link.click();
    URL.revokeObjectURL(url);
  }
}
