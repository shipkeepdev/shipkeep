import { ChangeDetectionStrategy, Component, inject, PendingTasks } from '@angular/core';
import { RouterModule } from '@angular/router';

import { SessionStore } from './identity/session-store';

@Component({
  imports: [RouterModule],
  selector: 'sk-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly session = inject(SessionStore);
  constructor() {
    inject(PendingTasks).run(() => this.session.refresh());
  }
}
