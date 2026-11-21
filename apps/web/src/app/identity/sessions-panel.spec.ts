import { TestBed } from '@angular/core/testing';

import { I18n } from '../ui/i18n';

import { IdentityApi, IdentityRequestError, type IdentitySchema } from './identity-api';
import { SessionsPanel } from './sessions-panel';

type Session = IdentitySchema<'AccountSessionDto'>;
const at = '2026-11-21T10:00:00Z';
const session = (
  id: string,
  current: boolean,
  browser: string | null,
  system: string | null,
): Session => ({
  id,
  current,
  browser,
  system,
  ip: '203.0.113.7',
  createdAt: at,
  lastSeenAt: at,
  expiresAt: '2026-11-22T10:00:00Z',
});

// The language is kept in localStorage: put it back, or later files read French.
afterEach(() => {
  try {
    localStorage.removeItem('shipkeep-lang');
  } catch {
    // No storage: nothing was kept.
  }
});

describe('sessions panel', () => {
  async function render(language: 'en' | 'fr' = 'en') {
    let items: Session[] = [
      session('this', true, 'Firefox', 'Linux'),
      session('phone', false, 'Safari', 'iOS'),
      session('script', false, null, null),
    ];
    const api = {
      sessions: vi.fn<IdentityApi['sessions']>(() => Promise.resolve(items)),
      revokeSession: vi.fn<IdentityApi['revokeSession']>((id) => {
        items = items.filter((item) => item.id !== id);
        return Promise.resolve();
      }),
    };
    TestBed.configureTestingModule({
      imports: [SessionsPanel],
      providers: [{ provide: IdentityApi, useValue: api }],
    });
    TestBed.inject(I18n).use(language);
    const fixture = TestBed.createComponent(SessionsPanel);
    await fixture.whenStable();
    fixture.detectChanges();
    return { api, fixture, element: fixture.nativeElement as HTMLElement };
  }

  it('marks this device, names the others, and signs one out', async () => {
    const { api, fixture, element } = await render();
    const rows = () =>
      [...element.querySelectorAll('li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim());
    expect(rows()[0]).toContain('Firefox on Linux');
    expect(rows()[0]).toContain('This device');
    expect(rows()[1]).toContain('Safari on iOS');
    expect(rows()[1]).toContain('203.0.113.7');
    expect(rows()[2]).toContain('Unknown device');
    // This session is never offered here: it ends by signing out of the account.
    const buttons = [...element.querySelectorAll('li button')];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Sign out Safari on iOS');
    (buttons[0] as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.revokeSession).toHaveBeenCalledWith('phone');
    expect(rows()).toHaveLength(2);
  });

  it('reads the list again after a 404, and a failure never blocks the next sign-out', async () => {
    const { api, fixture, element } = await render();
    const signOut = async (index: number) => {
      ([...element.querySelectorAll('li button')][index] as HTMLButtonElement).click();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    // An earlier attempt ended the session but its answer was lost: the retry finds nothing.
    api.revokeSession.mockRejectedValueOnce(new IdentityRequestError(404));
    await signOut(0);
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(api.sessions).toHaveBeenCalledTimes(2);
    api.revokeSession.mockRejectedValueOnce(new IdentityRequestError(503));
    await signOut(1);
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'could not be signed out',
    );
    await signOut(1);
    expect(api.revokeSession).toHaveBeenCalledTimes(3);
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  it('writes the device in French', async () => {
    const { element } = await render('fr');
    expect(element.textContent).toContain('Safari sur iOS');
    expect(element.textContent).toContain('Cet appareil');
  });
});
