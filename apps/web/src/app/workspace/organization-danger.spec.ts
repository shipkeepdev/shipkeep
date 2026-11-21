import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { AccessApi, type Member, type OrganizationRole } from '../access/access-api';
import { ShellContext } from '../shell/shell-context';
import { I18n } from '../ui/i18n';

import { OrganizationDanger } from './organization-danger';

const ORG = '01900000-0000-7000-8000-000000000001';
const member = (id: string, email: string, orgRole: OrganizationRole): Member => ({
  id,
  email,
  orgRole,
  active: true,
  organizationId: ORG,
  userId: id.replace('m', 'u'),
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
});

describe('organization danger zone', () => {
  async function render(role: OrganizationRole, people: Member[]) {
    const api = {
      members: vi.fn<AccessApi['members']>(() =>
        Promise.resolve({ items: people, nextCursor: null }),
      ),
      transferOwnership: vi.fn<AccessApi['transferOwnership']>(() => Promise.resolve()),
    };
    const shell = {
      role: signal<OrganizationRole | null>(role),
      refresh: vi.fn(() => Promise.resolve()),
    };
    TestBed.configureTestingModule({
      imports: [OrganizationDanger],
      providers: [
        provideRouter([]),
        { provide: AccessApi, useValue: api },
        { provide: ShellContext, useValue: shell },
      ],
    });
    TestBed.inject(I18n).use('en');
    const fixture = TestBed.createComponent(OrganizationDanger);
    fixture.componentRef.setInput('organizationId', ORG);
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const button = (label: string) =>
      [...element.querySelectorAll('button')].find(
        (b) => b.textContent.trim() === label,
      ) as HTMLButtonElement;
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { api, shell, fixture, element, button, settle };
  }

  it('hands ownership to the chosen admin under a fresh password, then refreshes the role', async () => {
    const { api, shell, element, button, settle } = await render('owner', [
      member('m1', 'me@example.com', 'owner'),
      member('m2', 'ada@example.com', 'admin'),
      member('m3', 'lin@example.com', 'admin'),
      member('m4', 'sam@example.com', 'member'),
    ]);
    button('Transfer').click();
    await settle();
    const options = [...element.querySelectorAll('option')].map((o) => o.textContent.trim());
    expect(options).toEqual(['ada@example.com', 'lin@example.com']);
    const select = element.querySelector('#transfer-ownership-target') as HTMLSelectElement;
    select.value = 'm3';
    select.dispatchEvent(new Event('change'));
    const password = element.querySelector('#transfer-ownership-password') as HTMLInputElement;
    password.value = 'correct horse battery staple';
    password.dispatchEvent(new Event('input'));
    await settle();
    (element.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    expect(api.transferOwnership).toHaveBeenCalledWith(
      ORG,
      'm3',
      { password: 'correct horse battery staple' },
      expect.any(String),
    );
    expect(shell.refresh).toHaveBeenCalled();
    expect(element.textContent).toContain('Ownership transferred. You are now an admin.');
    expect(element.querySelector('form')).toBeNull();
  });

  it('points to Members & access when no active admin can take ownership', async () => {
    const { element, button, settle } = await render('owner', [
      member('m1', 'me@example.com', 'owner'),
      { ...member('m2', 'ada@example.com', 'admin'), active: false },
      member('m4', 'sam@example.com', 'member'),
    ]);
    button('Transfer').click();
    await settle();
    expect(element.textContent).toContain('Make a member an admin first.');
    expect(element.querySelector('form')).toBeNull();
  });

  it('reads further members before saying no admin exists', async () => {
    const { api, element, button, settle } = await render('owner', []);
    api.members.mockImplementation((_org, cursor) => {
      const n = cursor ? Number(cursor) : 1;
      return Promise.resolve({
        items: [
          member(`m${String(n)}`, `p${String(n)}@example.com`, n === 11 ? 'admin' : 'member'),
        ],
        nextCursor: n < 11 ? String(n + 1) : null,
      });
    });
    const flush = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await settle();
    };
    button('Transfer').click();
    await flush();
    expect(element.textContent).toContain('No active admin among the members read so far.');
    expect(element.querySelector('form')).toBeNull();
    button('Read more members').click();
    await flush();
    const options = [...element.querySelectorAll('option')].map((o) => o.textContent.trim());
    expect(options).toEqual(['p11@example.com']);
    expect(button('Read more members')).toBeUndefined();
  });

  it('forgets a typed password when the form is cancelled', async () => {
    const { element, button, settle } = await render('owner', [
      member('m1', 'me@example.com', 'owner'),
      member('m2', 'ada@example.com', 'admin'),
    ]);
    button('Transfer').click();
    await settle();
    const typed = element.querySelector('#transfer-ownership-password') as HTMLInputElement;
    typed.value = 'correct horse battery staple';
    typed.dispatchEvent(new Event('input'));
    await settle();
    button('Cancel').click();
    await settle();
    button('Transfer').click();
    await settle();
    expect((element.querySelector('#transfer-ownership-password') as HTMLInputElement).value).toBe(
      '',
    );
  });

  it('lets only an owner start a transfer, and keeps deletion unavailable', async () => {
    const { api, element, button } = await render('admin', []);
    expect(button('Transfer').disabled).toBe(true);
    expect(element.textContent).toContain('Only an owner can hand over ownership.');
    expect(button('Delete').disabled).toBe(true);
    expect(element.textContent).toContain('Deleting an organization is not available yet.');
    expect(api.members).not.toHaveBeenCalled();
  });
});
