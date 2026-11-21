import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { I18n } from '../ui/i18n';

import { CommandPalette, type PaletteEntry } from './command-palette';

describe('command palette', () => {
  it('matches the name or where it lives, and says when more may come', async () => {
    TestBed.configureTestingModule({ imports: [CommandPalette], providers: [provideRouter([])] });
    TestBed.inject(I18n).use('en');
    const fixture = TestBed.createComponent(CommandPalette);
    const entries: PaletteEntry[] = [
      { label: 'Overview', icon: 'layout-dashboard', link: ['/'] },
      { label: 'storefront', detail: 'Demo · production', raw: true, icon: 'box', link: ['/a'] },
      { label: 'worker', detail: 'Billing · staging', raw: true, icon: 'box', link: ['/b'] },
    ];
    fixture.componentRef.setInput('entries', entries);
    fixture.componentRef.setInput('searching', true);
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector('input') as HTMLInputElement;
    const type = (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    const options = () =>
      [...element.querySelectorAll('[role=option]')].map((o) =>
        o.textContent.replace(/\s+/g, ' ').trim(),
      );
    type('staging');
    expect(options()).toEqual(['workerBilling · staging']);
    type('demo');
    expect(options()).toEqual(['storefrontDemo · production']);
    type('nothing like it');
    expect(element.textContent).toContain('Searching…');
  });
});
