import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { App } from './app';
import { IdentityApi, IdentityRequestError } from './identity/identity-api';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        {
          provide: IdentityApi,
          useValue: {
            session: vi.fn().mockRejectedValue(new IdentityRequestError(401)),
          },
        },
      ],
    }).compileComponents();
  });

  it('renders the product name', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('header a')?.textContent).toContain('Shipkeep');
    expect(compiled.querySelector('nav[aria-label="Account"]')?.textContent).toContain('Sign in');
    expect(compiled.querySelector('.skip-link')?.getAttribute('href')).toBe('#main-content');
  });
});
