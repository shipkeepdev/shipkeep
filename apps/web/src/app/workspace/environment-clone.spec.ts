import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { DeliveryApi } from '../delivery/delivery-api';
import { IdentityRequestError } from '../identity/identity-api';
import { ShellContext } from '../shell/shell-context';
import { I18n } from '../ui/i18n';

import { EnvironmentClone } from './environment-clone';

const REF = {
  organizationId: '01900000-0000-7000-8000-000000000001',
  projectId: '01900000-0000-7000-8000-000000000002',
  environmentId: '01900000-0000-7000-8000-000000000003',
};
const CLONED = '01900000-0000-7000-8000-000000000004';

describe('environment clone', () => {
  async function render(clone: DeliveryApi['cloneEnvironment']) {
    const api = { cloneEnvironment: vi.fn(clone) };
    const shell = { refresh: vi.fn(() => Promise.resolve()) };
    TestBed.configureTestingModule({
      imports: [EnvironmentClone],
      providers: [
        provideRouter([]),
        { provide: DeliveryApi, useValue: api },
        { provide: ShellContext, useValue: shell },
      ],
    });
    TestBed.inject(I18n).use('en');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(EnvironmentClone);
    fixture.componentRef.setInput('environment', REF);
    fixture.componentRef.setInput('source', 'production');
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const type = async (value: string) => {
      const input = element.querySelector('#clone-name') as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const submit = async () => {
      (element.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const button = () => element.querySelector('button[type=submit]') as HTMLButtonElement;
    return { api, shell, navigate, element, type, submit, button };
  }

  it('says what is copied, clones under the new name and opens the new environment', async () => {
    const { api, shell, navigate, element, type, submit, button } = await render(() =>
      Promise.resolve({ environmentId: CLONED, name: 'staging', applications: [] }),
    );
    expect(element.textContent).toContain('Clone production');
    expect(element.textContent).toContain('not deployed');
    expect(button().disabled).toBe(true);
    await type('  staging ');
    expect(button().disabled).toBe(false);
    await submit();
    expect(api.cloneEnvironment).toHaveBeenCalledWith(REF, 'staging');
    expect(shell.refresh).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith([
      '/orgs',
      REF.organizationId,
      'projects',
      REF.projectId,
      'environments',
      CLONED,
    ]);
  });

  it('shows a taken name and lets another one be tried', async () => {
    let calls = 0;
    const { api, navigate, element, type, submit, button } = await render(() => {
      calls++;
      return calls === 1
        ? Promise.reject(new IdentityRequestError(409, 0, { code: 'environment_conflict' }))
        : Promise.resolve({ environmentId: CLONED, name: 'staging-2', applications: [] });
    });
    await type('staging');
    await submit();
    expect(element.querySelector('[role=alert]')).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    await type('staging-2');
    expect(button().disabled).toBe(false);
    await submit();
    expect(api.cloneEnvironment).toHaveBeenLastCalledWith(REF, 'staging-2');
    expect(navigate).toHaveBeenCalled();
  });
});
