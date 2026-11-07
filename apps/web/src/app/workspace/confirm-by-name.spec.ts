import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';

import { ConfirmByName } from './confirm-by-name';

@Component({
  imports: [ConfirmByName],
  template: `
    <button id="opener" type="button" (click)="open.set(true)">Open</button>
    @if (open()) {
      <sk-confirm-by-name
        heading="Delete it"
        fieldLabel="Name"
        actionLabel="Delete"
        busyLabel="Deleting…"
        [resourceName]="name()"
        [busy]="busy()"
        (confirmed)="confirmed.push($event)"
        (cancelled)="open.set(false)"
      >
        This cannot be undone.
      </sk-confirm-by-name>
    }
  `,
})
class Host {
  readonly open = signal(false);
  readonly name = signal('production');
  readonly busy = signal(false);
  readonly confirmed: string[] = [];
}

describe('confirm by name', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  const element = () => fixture.nativeElement as HTMLElement;
  const field = () => element().querySelector<HTMLInputElement>('#confirm-name');
  const action = () => element().querySelector<HTMLButtonElement>('button[type="submit"]');
  function type(value: string): void {
    const input = field();
    if (!input) throw new Error('missing field');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }
  const submit = () => {
    element()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    fixture.detectChanges();
  };

  beforeEach(async () => {
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    document.body.appendChild(element());
    fixture.detectChanges();
    element().querySelector<HTMLButtonElement>('#opener')?.focus();
    element().querySelector<HTMLButtonElement>('#opener')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
  });
  afterEach(() => {
    element().remove();
  });

  it('confirms only on the exact name', () => {
    expect(action()?.disabled).toBe(true);
    for (const wrong of [
      '',
      'Production',
      'PRODUCTION',
      ' production',
      'production ',
      'productio',
      'prοduction', // Greek omicron
      "production' OR '1'='1",
    ]) {
      type(wrong);
      expect(action()?.disabled).toBe(true);
      submit();
    }
    expect(host.confirmed).toEqual([]);
    type('production');
    expect(action()?.disabled).toBe(false);
    submit();
    expect(host.confirmed).toEqual(['production']);
  });

  it('does not confirm twice while the action runs', () => {
    type('production');
    host.busy.set(true);
    fixture.detectChanges();
    expect(action()?.disabled).toBe(true);
    expect(action()?.textContent).toContain('Deleting…');
    submit();
    expect(host.confirmed).toEqual([]);
  });

  it('is announced, takes focus and gives it back when dismissed', async () => {
    const dialog = element().querySelector('[role="alertdialog"]');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('confirm-title');
    expect(document.activeElement).toBe(field());
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.open()).toBe(false);
    expect(document.activeElement?.id).toBe('opener');
  });

  it('starts over when another resource is selected', async () => {
    type('production');
    host.name.set('staging');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(field()?.value).toBe('');
    expect(action()?.disabled).toBe(true);
    expect(element().textContent).toContain('staging');
  });
});
