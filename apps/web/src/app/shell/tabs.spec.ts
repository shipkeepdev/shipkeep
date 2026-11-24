import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

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
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
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

  it('scrolls a narrow bar so that the active tab shows', async () => {
    const { fixture, tab } = setup();
    const list = tab('one')?.parentElement as HTMLElement;
    const box = (left: number, right: number) => () => ({ left, right }) as DOMRect;
    list.getBoundingClientRect = box(0, 100);
    (tab('one') as HTMLElement).getBoundingClientRect = box(0, 80);
    (tab('two') as HTMLElement).getBoundingClientRect = box(84, 170);
    fixture.componentInstance.active.set('two');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(list.scrollLeft).toBe(70);
  });
});
