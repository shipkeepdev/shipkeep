import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { I18n } from '../ui/i18n';

import { ApplicationsPanel } from './applications-panel';
import { type Application, DeliveryApi, type EnvironmentRef } from './delivery-api';

const env = (environmentId: string): EnvironmentRef => ({
  organizationId: '01900000-0000-7000-8000-000000000001',
  projectId: '01900000-0000-7000-8000-000000000002',
  environmentId,
});
const app = (id: string, name: string) =>
  ({
    id,
    name,
    source: 'image',
    config: { build: { type: 'image', image: 'nginx:1.27' } },
  }) as unknown as Application;

describe('applications panel', () => {
  it("never asks about one environment's applications under another (#257)", async () => {
    const production = env('01900000-0000-7000-8000-00000000000a');
    const staging = env('01900000-0000-7000-8000-00000000000b');
    let release: (items: Application[]) => void = () => undefined;
    const api = {
      applications: vi.fn((ref: EnvironmentRef) =>
        ref === production
          ? Promise.resolve([app('a1', 'shop')])
          : new Promise<Application[]>((resolve) => {
              release = resolve;
            }),
      ),
      deployments: vi.fn(() => Promise.resolve([])),
    };
    TestBed.configureTestingModule({
      imports: [ApplicationsPanel],
      providers: [provideRouter([]), { provide: DeliveryApi, useValue: api }],
    });
    TestBed.inject(I18n).use('en');
    const fixture = TestBed.createComponent(ApplicationsPanel);
    fixture.componentRef.setInput('environment', production);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.deployments).toHaveBeenCalledWith(production, 'a1');

    fixture.componentRef.setInput('environment', staging);
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    // The staging list has not arrived: nothing is asked about production's shop under staging.
    expect(api.deployments).not.toHaveBeenCalledWith(staging, 'a1');

    release([app('b1', 'shop')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.deployments).toHaveBeenCalledWith(staging, 'b1');
    expect(api.deployments).not.toHaveBeenCalledWith(staging, 'a1');
  });

  it("asks nothing when the new environment's list fails to load", async () => {
    const production = env('01900000-0000-7000-8000-00000000000a');
    const staging = env('01900000-0000-7000-8000-00000000000b');
    const api = {
      applications: vi.fn((ref: EnvironmentRef) =>
        ref === production
          ? Promise.resolve([app('a1', 'shop')])
          : Promise.reject(new Error('down')),
      ),
      deployments: vi.fn(() => Promise.resolve([])),
    };
    TestBed.configureTestingModule({
      imports: [ApplicationsPanel],
      providers: [provideRouter([]), { provide: DeliveryApi, useValue: api }],
    });
    TestBed.inject(I18n).use('en');
    const fixture = TestBed.createComponent(ApplicationsPanel);
    fixture.componentRef.setInput('environment', production);
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.componentRef.setInput('environment', staging);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.deployments).not.toHaveBeenCalledWith(staging, 'a1');
  });
});
