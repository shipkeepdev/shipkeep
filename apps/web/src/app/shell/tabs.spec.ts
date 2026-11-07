import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { type Tab, Tabs } from './tabs';

@Component({
  imports: [Tabs],
  template: `<sk-tabs label="Sections" [tabs]="tabs" [(active)]="active" />`,
})
class Host {
  readonly tabs: readonly Tab[] = [
    { id: 'one', label: 'One' },
    { id: 'two', label: 'Two' },
  ];
  readonly active = signal('one');
}

describe('tabs', () => {
  function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const tab = (id: string) => element.querySelector<HTMLButtonElement>(`#tab-${id}`);
    return { fixture, tab };
  }

  it('selects on click and marks only the active tab', () => {
    const { fixture, tab } = setup();
    expect(tab('one')?.getAttribute('aria-selected')).toBe('true');
    tab('two')?.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.active()).toBe('two');
    expect(tab('one')?.getAttribute('aria-selected')).toBe('false');
    expect(tab('two')?.getAttribute('tabindex')).toBe('0');
  });

  it('moves with the arrow keys and wraps around', () => {
    const { fixture, tab } = setup();
    tab('one')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.active()).toBe('two');
    tab('two')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.active()).toBe('one');
  });
});
