import { ChangeDetectionStrategy, Component, inject, PendingTasks } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { SessionStore } from './identity/session-store';
import { NoticeHost } from './ui/notice';

@Component({
  imports: [RouterOutlet, NoticeHost],
  selector: 'sk-root',
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly session = inject(SessionStore);

  constructor() {
    inject(PendingTasks).run(() => this.session.refresh());
  }
}
