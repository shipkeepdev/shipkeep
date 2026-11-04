import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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
    void this.session.refresh();
  }
}
