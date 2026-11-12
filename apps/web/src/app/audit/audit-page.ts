import { DatePipe, DOCUMENT, JsonPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidatorFn,
  Validators,
} from '@angular/forms';
import { Icon } from '../shell/icon';
import { ShellContext } from '../shell/shell-context';
import { I18n, T } from '../ui/i18n';

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
  imports: [DatePipe, Icon, JsonPipe, ReactiveFormsModule, T],
  providers: [AuditLogStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1 class="page-title">{{ 'Audit log' | t }}</h1>
          <div class="page-sub">
            {{
              'Every change is recorded, newest first. If recording fails, the change fails too.'
                | t
            }}
          </div>
        </div>
        <div class="flex flex-wrap gap-2.5">
          <button
            type="button"
            class="btn"
            [attr.aria-expanded]="filtering()"
            (click)="filtering.set(!filtering())"
          >
            <sk-icon name="adjustments" />{{ 'Filter' | t }}
          </button>
          <button type="button" class="btn" [disabled]="store.exporting()" (click)="export()">
            <sk-icon name="file-export" />{{
              (store.exporting() ? 'Exporting…' : 'Export as JSON Lines') | t
            }}
          </button>
        </div>
      </div>
      @if (filtering() || filtered()) {
        <form
          [formGroup]="form"
          (ngSubmit)="apply()"
          class="card grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3"
          [attr.aria-label]="'Filter audit events' | t"
        >
          @for (filter of filters; track filter.name) {
            <div class="flex flex-col gap-1.5">
              <label [for]="'audit-' + filter.name" class="text-[12px] text-fg3">{{
                filter.label | t
              }}</label>
              <input
                [id]="'audit-' + filter.name"
                class="input font-mono"
                [formControlName]="filter.name"
                [attr.maxlength]="filter.maxLength"
                [attr.aria-describedby]="'audit-' + filter.name + '-hint'"
                [attr.aria-invalid]="form.controls[filter.name].invalid"
                autocomplete="off"
                spellcheck="false"
              />
              <p
                [id]="'audit-' + filter.name + '-hint'"
                class="text-[11.5px]"
                [class.text-rose]="form.controls[filter.name].invalid"
                [class.text-dim]="!form.controls[filter.name].invalid"
              >
                {{ filter.hint | t }}
              </p>
            </div>
          }
          <div class="flex flex-col gap-1.5">
            <label for="audit-from" class="text-[12px] text-fg3">{{
              'From (your local time)' | t
            }}</label>
            <input id="audit-from" class="input" type="datetime-local" formControlName="from" />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="audit-to" class="text-[12px] text-fg3">{{
              'Before (your local time)' | t
            }}</label>
            <input
              id="audit-to"
              class="input"
              type="datetime-local"
              formControlName="to"
              aria-describedby="audit-period-error"
              [attr.aria-invalid]="form.hasError('period')"
            />
            @if (form.hasError('period')) {
              <p id="audit-period-error" class="text-[11.5px] text-rose">
                {{ 'This must be after the start.' | t }}
              </p>
            }
          </div>
          <div class="flex flex-wrap items-end gap-2.5 sm:col-span-2 lg:col-span-3">
            <button class="btn btn-primary" type="submit" [disabled]="form.invalid">
              {{ 'Apply filters' | t }}
            </button>
            <button class="btn btn-sm" type="button" (click)="clear()">{{ 'Clear' | t }}</button>
          </div>
        </form>
      }
      @if (store.exportProblem(); as problem) {
        <div class="alert" role="alert">{{ problem | t }}</div>
      }
      @if (truncated()) {
        <p role="status" class="note">
          {{
            'The export holds the most recent 10,000 events. Narrow the period to export older ones.'
              | t
          }}
        </p>
      }
      @if (store.problem(); as problem) {
        <div class="alert" role="alert">{{ problem | t }}</div>
      }
      <div
        class="card overflow-x-auto"
        role="region"
        [attr.aria-label]="'Audit events' | t"
        tabindex="0"
      >
        <div class="min-w-[760px]">
          <div
            [class]="
              columns + ' grid gap-3 border-b border-line px-5 py-2.5 text-[11.5px] text-dim2'
            "
          >
            <span>{{ 'Date' | t }}</span
            ><span>{{ 'Actor' | t }}</span
            ><span>{{ 'Action' | t }}</span
            ><span>{{ 'Target' | t }}</span
            ><span class="text-right">{{ 'Origin' | t }}</span>
          </div>
          @switch (store.state()) {
            @case ('loading') {
              <p role="status" class="px-5 py-4 text-[13px] text-mute2">{{ 'Loading…' | t }}</p>
            }
            @case ('ready') {
              @for (event of store.events(); track event.id) {
                <button
                  type="button"
                  [class]="
                    columns +
                    ' grid w-full items-center gap-3 border-b border-line2 px-5 py-3 text-left text-[13px] hover:bg-[#0a0a0b]'
                  "
                  [attr.aria-expanded]="open() === event.id"
                  (click)="open.set(open() === event.id ? null : event.id)"
                >
                  <time
                    class="font-mono text-[11.5px] text-mute"
                    [attr.datetime]="event.createdAt"
                    >{{ event.createdAt | date: 'dd/MM HH:mm:ss' }}</time
                  >
                  <span class="truncate">{{ actor(event) }}</span>
                  <span
                    class="truncate font-mono text-[11.5px]"
                    [style.color]="tone(event.action)"
                    >{{ event.action }}</span
                  >
                  <span class="truncate text-fg3"
                    >{{ event.targetType }} ·
                    <span class="font-mono text-[11.5px]">{{
                      event.targetId.slice(0, 13)
                    }}</span></span
                  >
                  <span class="text-right font-mono text-[11px] text-dim">{{
                    event.ip ?? (event.actorKind | t)
                  }}</span>
                </button>
                @if (open() === event.id) {
                  <div class="border-b border-line2 bg-[#0a0a0b] px-5 py-3">
                    <dl
                      class="m-0 grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]"
                    >
                      <dt class="text-dim">{{ 'Actor' | t }}</dt>
                      <dd class="m-0 font-mono break-all text-fg2">
                        {{ event.actorKind }} {{ event.actorId ?? '' }}
                      </dd>
                      <dt class="text-dim">{{ 'Target' | t }}</dt>
                      <dd class="m-0 font-mono break-all text-fg2">
                        {{ event.targetType }} {{ event.targetId }}
                      </dd>
                    </dl>
                    @if (hasDetails(event)) {
                      <pre class="code-box mt-2 max-h-64" tabindex="0">{{
                        event.metadata | json
                      }}</pre>
                    }
                  </div>
                }
              } @empty {
                <p class="px-5 py-6 text-[13px] text-mute2">
                  {{
                    (filtered()
                      ? 'No events match these filters.'
                      : 'Nothing has been recorded in this organization yet.'
                    ) | t
                  }}
                </p>
              }
            }
          }
        </div>
      </div>
      @if (store.hasMore()) {
        <div>
          <button
            class="btn btn-sm"
            type="button"
            [disabled]="store.loadingMore()"
            (click)="store.more()"
          >
            {{ (store.loadingMore() ? 'Loading…' : 'Load older events') | t }}
          </button>
        </div>
      }
    </div>
  `,
})
export class AuditPage {
  private readonly document = inject(DOCUMENT);
  protected readonly store = inject(AuditLogStore);
  readonly organizationId = input.required<string>();
  protected readonly filters = FILTERS;
  protected readonly form = filterForm();
  protected readonly truncated = signal(false);
  protected readonly filtering = signal(false);
  protected readonly open = signal<string | null>(null);
  protected readonly columns =
    'grid-cols-[minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,0.7fr)]';
  private readonly shell = inject(ShellContext);
  private readonly i18n = inject(I18n);

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
  protected actor(event: AuditEvent): string {
    if (event.actorKind === 'system') return this.i18n.t('system');
    if (event.actorKind === 'node') return this.i18n.t('agent');
    if (event.actorKind === 'api_token') return this.i18n.t('API token');
    return (event.actorId && this.shell.emails().get(event.actorId)) || this.i18n.t('user');
  }
  /** Removals in red, access and secrets in blue, the rest neutral, as in the design. */
  protected tone(action: string): string {
    if (/\.(remove|delete|revoke|disable)/.test(action)) return 'oklch(0.68 0.17 25)';
    if (/restore|rollback|failed/.test(action)) return 'oklch(0.80 0.12 80)';
    if (/^(join_token|api_token|member|binding|mfa)\./.test(action)) return 'oklch(0.72 0.13 250)';
    return '#A6A6AE';
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
