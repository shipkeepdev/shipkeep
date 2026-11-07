import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import { ShellContext } from '../shell/shell-context';
import { PREVIEW_SCREENS, type PreviewView } from './preview-screens';
import { ScreenView } from './screen-view';

/** A design screen with its sample data, for a feature the control plane does not serve yet. */
@Component({
  selector: 'sk-preview-page',
  imports: [ScreenView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<sk-screen
    [screen]="screen()"
    [organizationId]="organizationId()"
    [preview]="true"
  />`,
})
export class PreviewPage {
  private readonly view = toSignal(
    inject(ActivatedRoute).data.pipe(map((data) => data['view'] as PreviewView)),
    { requireSync: true },
  );
  protected readonly screen = computed(() => PREVIEW_SCREENS[this.view()]);
  private readonly shell = inject(ShellContext);
  protected readonly organizationId = computed(() => this.shell.organizationId() ?? '');
}
