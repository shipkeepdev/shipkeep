import { TestBed } from '@angular/core/testing';

import { I18n } from '../ui/i18n';

import { DisplayNameField } from './display-name-field';
import { IdentityApi, IdentityRequestError, type SessionProfile } from './identity-api';
import { SessionStore } from './session-store';

describe('display name field', () => {
  const profile = {
    userId: 'fixture',
    email: 'ada@example.com',
    displayName: null,
    expiresAt: '2030-01-01T00:00:00Z',
  };

  async function render() {
    const api = { setDisplayName: vi.fn<IdentityApi['setDisplayName']>() };
    TestBed.configureTestingModule({
      imports: [DisplayNameField],
      providers: [{ provide: IdentityApi, useValue: api }],
    });
    TestBed.inject(I18n).use('en');
    const session = TestBed.inject(SessionStore);
    session.accept(profile);
    const fixture = TestBed.createComponent(DisplayNameField);
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector('input') as HTMLInputElement;
    const type = (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    const submit = async () => {
      element.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { api, session, fixture, element, type, submit };
  }

  it('saves a trimmed name, and the session follows', async () => {
    const { api, session, element, type, submit } = await render();
    api.setDisplayName.mockResolvedValue({ ...profile, displayName: 'Ada Lovelace' });
    type('  Ada Lovelace  ');
    await submit();
    expect(api.setDisplayName).toHaveBeenCalledWith('Ada Lovelace');
    expect(session.profile()?.displayName).toBe('Ada Lovelace');
    expect(element.textContent).toContain('Saved.');
  });

  it('counts 64 characters as the server does, not UTF-16 units', async () => {
    const { element, type } = await render();
    const button = () => element.querySelector('button') as HTMLButtonElement;
    // 33 letters outside the basic plane: 66 UTF-16 units, 33 characters.
    type('𝒜'.repeat(33));
    expect(button().disabled).toBe(false);
    type('a'.repeat(65));
    expect(button().disabled).toBe(true);
    expect(element.textContent).toContain('at most 64 characters');
    type(`  ${'a'.repeat(64)}  `);
    expect(button().disabled).toBe(false);
  });

  it('holds the field while a save is pending, so a later edit is not overwritten', async () => {
    const { api, fixture, element, type, submit } = await render();
    let resolve: ((value: SessionProfile) => void) | undefined;
    api.setDisplayName.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    type('Ada');
    const saving = submit();
    fixture.detectChanges();
    expect((element.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    resolve?.({ ...profile, displayName: 'Ada' });
    await saving;
  });

  it('removes the name when the field is emptied, and says why a name is refused', async () => {
    const { api, element, type, submit } = await render();
    api.setDisplayName.mockRejectedValueOnce(new IdentityRequestError(400));
    type('x');
    await submit();
    expect(element.textContent).toContain('at most 64 characters');
    api.setDisplayName.mockResolvedValue(profile);
    type('   ');
    // Nothing to save: the name is already empty.
    expect((element.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
