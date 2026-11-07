import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { type BrandName } from '../shell/brands';
import { ShellContext } from '../shell/shell-context';
import { Brand } from '../ui/brand';
import { T } from '../ui/i18n';
import { Notice } from '../ui/notice';
import { GREEN, RED } from './format';
import { PreviewPill } from './screen-view';

const DATABASES: readonly {
  name: string;
  engine: string;
  logo: BrandName;
  env: string;
  size: string;
  last: string;
  color: string;
}[] = [
  {
    name: 'pg-lumen',
    engine: 'PostgreSQL 17',
    logo: 'postgresql',
    env: 'Client Lumen · production',
    size: '4.2 GiB',
    last: '8 h ago',
    color: GREEN,
  },
  {
    name: 'pg-verdi',
    engine: 'PostgreSQL 16',
    logo: 'postgresql',
    env: 'Client Verdi · production',
    size: '1.8 GiB',
    last: '8 h ago',
    color: GREEN,
  },
  {
    name: 'redis-sessions',
    engine: 'Redis 7.4',
    logo: 'redis',
    env: 'Client Lumen · production',
    size: '310 MB',
    last: 'not backed up',
    color: '#7C7C85',
  },
  {
    name: 'maria-vitrine',
    engine: 'MariaDB 11',
    logo: 'mariadb',
    env: 'Marketing site · production',
    size: '96 MB',
    last: '8 h ago',
    color: GREEN,
  },
];
const BACKUPS = ['07/11 02:00', '06/11 02:00', '05/11 02:00', '04/11 02:00'];
const SIZES = ['412 MB', '409 MB', '407 MB', '401 MB'];

/** 04 Databases: managed databases and their backups. Not built yet: the design's sample. */
@Component({
  selector: 'sk-databases-page',
  imports: [Brand, PreviewPill, RouterLink, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div>
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="page-title">{{ 'Databases' | t }}</h1>
          <sk-preview-pill />
        </div>
        <div class="page-sub">
          {{ 'Managed databases, volumes and encrypted backups to your S3 storage.' | t }}
        </div>
      </div>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
        @for (d of databases; track d.name; let i = $index) {
          <button
            type="button"
            class="flex cursor-pointer flex-col gap-3 rounded-[14px] border bg-black p-[18px] text-left"
            [style.border-color]="selected() === i ? '#3A3A42' : '#1D1D21'"
            (click)="select(i)"
          >
            <div class="flex w-full items-center justify-between">
              <a
                [routerLink]="['/orgs', organizationId(), 'databases', 'sample']"
                class="font-mono text-[13px] underline decoration-[#3A3A40] underline-offset-[3px]"
                (click)="$event.stopPropagation()"
                >{{ d.name }}</a
              >
              <span
                class="flex items-center gap-1.5 rounded-md bg-sel px-2 py-[3px] text-[11px] text-fg3"
                ><sk-brand [name]="d.logo" class="size-3 text-fg3" />{{ d.engine }}</span
              >
            </div>
            <div class="flex w-full justify-between text-[12px] text-mute2">
              <span>{{ d.env | t }}</span
              ><span>{{ d.size }}</span>
            </div>
            <div class="flex w-full justify-between border-t border-line pt-2.5 text-[12px]">
              <span class="text-mute">{{ 'Last backup' | t }}</span
              ><span [style.color]="d.color">{{ d.last | t }}</span>
            </div>
          </button>
        }
      </div>
      <div class="flex flex-wrap items-start gap-3.5">
        <div class="card flex min-w-0 flex-[1.4_1_520px] flex-col gap-4 p-5">
          <div class="flex flex-wrap items-center justify-between gap-2.5">
            <span class="card-title"
              >{{ 'Backups of' | t }} {{ current().name }} · {{ '14 days' | t }}</span
            >
            <span class="text-[12px] text-mute2">{{ 'Daily 02:00 · 30 d retention' | t }}</span>
          </div>
          <div
            class="grid h-[120px] grid-cols-[repeat(14,minmax(0,1fr))] items-end gap-1.5 border-b border-line"
          >
            @for (b of bars(); track $index) {
              <div class="rounded-t-[3px]" [style.height]="b.h" [style.background]="b.bg"></div>
            }
          </div>
          <div
            class="grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1.5 text-center font-mono text-[10px] text-dim2"
          >
            @for (b of bars(); track $index) {
              <span>{{ b.d }}</span>
            }
          </div>
          <div class="flex flex-col">
            @for (at of backups; track at; let i = $index) {
              <div
                class="grid grid-cols-[minmax(0,1fr)_minmax(0,0.6fr)_minmax(0,0.6fr)_auto] items-center gap-3 border-t border-line2 py-2.5 text-[12.5px]"
              >
                <span class="font-mono text-[11.5px] text-fg2">{{ at }}</span
                ><span class="text-mute">{{ sizes[i] }}</span
                ><span class="text-green">{{ 'encrypted · verified' | t }}</span>
                <button
                  type="button"
                  class="btn btn-xs"
                  (click)="restoreAt.set(at); inPlace.set(false); typed.set('')"
                >
                  {{ 'Restore' | t }}
                </button>
              </div>
            }
          </div>
        </div>
        <div class="card flex min-w-0 flex-[1_1_360px] flex-col gap-3 p-5">
          <div class="card-title">{{ 'Restore' | t }}</div>
          @if (restoreAt(); as at) {
            <div class="text-[13px] leading-[1.55] text-fg3">
              {{ 'Backup from' | t }} <span class="font-mono text-fg">{{ at }}</span>
            </div>
            <div class="seg">
              <button
                type="button"
                class="flex-1 text-center text-[12px]"
                [attr.aria-pressed]="!inPlace()"
                (click)="inPlace.set(false); typed.set('')"
              >
                {{ 'To a new database' | t }}
              </button>
              <button
                type="button"
                class="flex-1 text-center text-[12px]"
                [attr.aria-pressed]="inPlace()"
                (click)="inPlace.set(true); typed.set('')"
              >
                {{ 'In place' | t }}
              </button>
            </div>
            <div
              class="text-[12.5px] leading-[1.55]"
              [style.color]="inPlace() ? '#E0B8B8' : '#A6A6AE'"
            >
              {{
                (inPlace()
                  ? 'The current database will be replaced. A backup is taken right before. Type {name} to confirm.'
                  : 'A new database {name}-restore is created alongside. Nothing is overwritten.'
                ) | t: { name: current().name }
              }}
            </div>
            @if (inPlace()) {
              <input
                class="input font-mono"
                [placeholder]="'Type the database name' | t"
                [value]="typed()"
                (input)="typed.set($any($event.target).value)"
              />
            }
            <div>
              <button
                type="button"
                class="btn font-medium"
                [disabled]="inPlace() && typed() !== current().name"
                [class.btn-primary]="!inPlace()"
                [style.background]="inPlace() && typed() === current().name ? red : null"
                [style.color]="inPlace() && typed() === current().name ? '#0B0B0D' : null"
                (click)="notice.notYet('Restore')"
              >
                {{
                  (inPlace() ? 'Restore in place' : 'Create {name}-restore')
                    | t: { name: current().name }
                }}
              </button>
            </div>
          } @else {
            <div class="text-[13px] leading-[1.55] text-mute">
              {{
                'Choose a backup. Restoring to a new database is safe; restoring in place requires confirmation.'
                  | t
              }}
            </div>
          }
        </div>
      </div>
    </div>
  `,
})
export class DatabasesPage {
  protected readonly notice = inject(Notice);
  private readonly shell = inject(ShellContext);
  protected readonly organizationId = computed(() => this.shell.organizationId() ?? '');
  protected readonly databases = DATABASES;
  protected readonly backups = BACKUPS;
  protected readonly sizes = SIZES;
  protected readonly red = RED;
  protected readonly selected = signal(0);
  protected readonly restoreAt = signal<string | null>(null);
  protected readonly inPlace = signal(false);
  protected readonly typed = signal('');
  protected readonly current = computed(() => DATABASES[this.selected()] ?? DATABASES[0]);
  protected readonly bars = computed(() => {
    const db = this.selected();
    return Array.from({ length: 14 }, (_, i) => {
      const fail = i === 5 && db === 1;
      return {
        h: `${String(fail ? 18 : 55 + ((i * 7 + db * 5) % 30))}%`,
        bg: fail ? RED : i === 13 ? '#EDEDEF' : '#5E5E67',
        d: String(i + 25 > 31 ? i - 6 : i + 25),
      };
    });
  });

  protected select(index: number): void {
    this.selected.set(index);
    this.restoreAt.set(null);
  }
}
