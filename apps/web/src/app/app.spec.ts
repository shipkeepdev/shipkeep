import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { App } from './app';
import { appRoutes } from './app.routes';
import { IdentityApi, IdentityRequestError } from './identity/identity-api';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter(appRoutes),
        {
          provide: IdentityApi,
          useValue: {
            session: vi.fn().mockRejectedValue(new IdentityRequestError(401)),
          },
        },
      ],
    }).compileComponents();
  });

  it('opens on the sign-in screen of the design when signed out', async () => {
    const fixture = TestBed.createComponent(App);
    await TestBed.inject(Router).navigateByUrl('/auth/login');
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('header a')?.textContent).toContain('shipkeep');
    expect(compiled.querySelector('h1')?.textContent).toContain('Welcome back');
    expect(compiled.querySelector('main')?.id).toBe('main-content');
  });
});
