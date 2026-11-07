import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  PendingTasks,
} from '@angular/core';
import { RouterModule } from '@angular/router';

import { SessionStore } from './identity/session-store';
import { Icon } from './shell/icon';
import { Logo } from './shell/logo';
import { ShellContext } from './shell/shell-context';

@Component({
  imports: [RouterModule, Icon, Logo],
  selector: 'sk-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly document = inject(DOCUMENT);
  protected readonly session = inject(SessionStore);
  protected readonly shell = inject(ShellContext);
  protected readonly initials = computed(() =>
    (this.shell.organization()?.name ?? '')
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word.at(0)?.toUpperCase() ?? '')
      .join(''),
  );
  protected readonly home = computed(() => {
    const id = this.shell.organizationId();
    return id ? ['/orgs', id] : ['/orgs'];
  });

  protected skipToContent(event: Event): void {
    event.preventDefault();
    const main = this.document.getElementById('main-content');
    main?.focus();
    main?.scrollIntoView();
  }

  constructor() {
    inject(PendingTasks).run(() => this.session.refresh());
    effect(() => {
      this.shell.url();
      this.session.profile();
      void this.shell.refresh();
    });
  }
}
