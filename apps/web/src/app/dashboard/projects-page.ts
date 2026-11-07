import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { MutationRunner } from '../identity/mutation-runner';
import { Icon } from '../shell/icon';
import { ShellContext } from '../shell/shell-context';
import { T } from '../ui/i18n';
import { recoverOnEdit } from '../workspace/form-recovery';
import { OverviewStore } from '../workspace/overview-store';
import { required, slug } from '../workspace/validators';
import { type Environment, WorkspaceApi } from '../workspace/workspace-api';
import { AMBER, GREEN } from './format';

/** 09 Projects: one card per project, with its environments and what runs in them. */
@Component({
  selector: 'sk-projects-page',
  imports: [Icon, ReactiveFormsModule, RouterLink, T],
  providers: [MutationRunner, OverviewStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-[18px]">
      <div class="page-head">
        <div class="min-w-0">
          <h1 class="page-title">{{ 'Projects' | t }}</h1>
          <div class="mt-1.5 max-w-[720px] text-[13px] text-pretty text-mute2">
            {{
              'A project groups the environments of a client or a product. Each environment has its own resources, variables and rights.'
                | t
            }}
          </div>
        </div>
        <button type="button" class="btn btn-primary" (click)="creating.set(!creating())">
          <sk-icon name="plus" />{{ 'New project' | t }}
        </button>
      </div>
      @if (creating()) {
        <section
          class="card flex max-w-[640px] flex-col gap-3 p-5"
          aria-labelledby="project-create-title"
        >
          <h2 id="project-create-title" class="text-[15px] font-medium">{{ 'New project' | t }}</h2>
          @if (runner.problem(); as problem) {
            <div class="alert" role="alert">{{ problem | t }}</div>
          }
          <form [formGroup]="form" (ngSubmit)="create()" class="flex flex-col gap-3">
            <div class="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1">
              <div class="flex flex-col gap-1.5">
                <label for="project-name" class="text-[12px] text-fg3">{{ 'Name' | t }}</label>
                <input
                  id="project-name"
                  class="input"
                  formControlName="name"
                  maxlength="80"
                  autocomplete="off"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <label for="project-slug" class="text-[12px] text-fg3">{{
                  'Identifier' | t
                }}</label>
                <input
                  id="project-slug"
                  class="input font-mono"
                  formControlName="slug"
                  maxlength="40"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="client-lumen"
                />
              </div>
            </div>
            <div class="flex gap-2.5">
              <button
                class="btn btn-primary"
                type="submit"
                [disabled]="runner.busy() || !!runner.cooldown() || form.invalid"
              >
                {{ (runner.busy() ? 'Creating…' : 'Create project') | t }}
              </button>
              <button class="btn btn-sm" type="button" (click)="creating.set(false)">
                {{ 'Cancel' | t }}
              </button>
            </div>
          </form>
        </section>
      }
      <div class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3">
        @for (p of cards(); track p.id) {
          <a
            [routerLink]="['/orgs', organizationId(), 'projects', p.id]"
            class="flex flex-col gap-3 rounded-2xl border border-line bg-black p-4 transition-[border-color] duration-200 hover:border-[#3A3A40]"
          >
            <div class="flex items-center gap-3">
              <span
                class="grid size-[38px] shrink-0 place-items-center rounded-[10px] border border-line"
                ><sk-icon name="folder" class="text-[19px] text-fg2"
              /></span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-[7px] text-[13.5px] font-medium">
                  <span class="truncate">{{ p.name }}</span>
                  @if (p.badge) {
                    <span
                      class="flex items-center gap-[5px] rounded-full border border-ctl px-2 py-px text-[10.5px] font-normal whitespace-nowrap"
                      [style.color]="p.badgeColor"
                      ><span
                        class="size-[5px] rounded-full"
                        [style.background]="p.badgeColor"
                      ></span
                      >{{ p.badge | t: { n: p.failing } }}</span
                    >
                  }
                </div>
                <div class="mt-0.5 truncate text-[11.5px] text-dim">
                  {{ p.environments || ('no environment yet' | t) }}
                </div>
              </div>
            </div>
            <div class="flex-1 font-mono text-[12px] text-mute2">{{ p.slug }}</div>
            <div class="flex flex-wrap gap-3.5 border-t border-line2 pt-3 text-[11.5px] text-mute">
              <span class="flex items-center gap-[5px]"
                ><sk-icon name="apps" class="text-[13px]" />{{
                  '{n} applications' | t: { n: p.apps }
                }}</span
              >
              <span class="flex items-center gap-[5px]"
                ><sk-icon name="stack-2" class="text-[13px]" />{{
                  '{n} environments' | t: { n: p.environmentCount }
                }}</span
              >
            </div>
          </a>
        } @empty {
          <p class="text-[13px] text-mute2">
            {{ (store.loading() ? 'Loading…' : 'No project yet.') | t }}
          </p>
        }
      </div>
    </div>
  `,
})
export class ProjectsPage {
  private readonly api = inject(WorkspaceApi);
  private readonly shell = inject(ShellContext);
  protected readonly store = inject(OverviewStore);
  protected readonly runner = inject(MutationRunner);
  protected readonly creating = signal(false);
  protected readonly organizationId = computed(() => this.shell.organizationId() ?? '');
  private readonly environments = signal<ReadonlyMap<string, readonly Environment[]>>(new Map());
  protected readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [required] }),
    slug: new FormControl('', { nonNullable: true, validators: [required, slug] }),
  });
  protected readonly cards = computed(() =>
    this.shell.projects().map((project) => {
      const apps = this.store.applications().filter((a) => a.project === project.name);
      const failing = apps.filter((a) => a.deployments.at(0)?.state === 'failed').length;
      const environments = this.environments().get(project.id) ?? [];
      return {
        ...project,
        environments: environments.map((e) => e.name).join(' · '),
        environmentCount: environments.length,
        apps: apps.length,
        failing,
        badge: failing
          ? '{n} failing'
          : apps.some((a) => a.deployments.at(0)?.state === 'succeeded')
            ? 'live'
            : '',
        badgeColor: failing ? AMBER : GREEN,
      };
    }),
  );

  constructor() {
    recoverOnEdit(this.form, this.runner);
    effect(() => {
      const id = this.shell.organizationId();
      if (id) void this.store.load(id);
    });
    effect(() => {
      const id = this.organizationId();
      const projects = this.shell.projects();
      void Promise.all(
        projects.map(
          async (p) => [p.id, await this.api.environments(id, p.id).catch(() => [])] as const,
        ),
      ).then((entries) => {
        this.environments.set(new Map(entries));
      });
    });
  }

  protected async create(): Promise<void> {
    const value = this.form.getRawValue();
    const body = {
      name: value.name.trim(),
      slug: value.slug.trim(),
      gitWriteMode: 'commit' as const,
    };
    const outcome = await this.runner.run(body, (key) =>
      this.api.createProject(this.organizationId(), body, key),
    );
    if (!outcome.ok) return;
    this.form.reset();
    this.creating.set(false);
    await this.shell.refresh();
  }
}
