import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18n } from '../ui/i18n';

import { BuildOutputPanel } from './build-output-panel';
import { type BuildOutput, DeliveryApi } from './delivery-api';

const environment = {
  organizationId: '0190f5a8-7b1c-7e2d-8f3a-0000000000aa',
  projectId: '0190f5a8-7b1c-7e2d-8f3a-0000000000bb',
  environmentId: '0190f5a8-7b1c-7e2d-8f3a-0000000000cc',
};
const EMPTY: BuildOutput = { kept: true, lines: [] };

describe('build output panel (#265)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a last read for after a read still under way once the deployment has finished', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let release: () => void = () => undefined;
    const api = {
      buildOutput: () => {
        reads++;
        // The first read after the end is slow: it is still under way at the next tick.
        if (reads === 2)
          return new Promise<BuildOutput>((resolve) => {
            release = () => {
              resolve(EMPTY);
            };
          });
        return Promise.resolve(EMPTY);
      },
    };
    TestBed.configureTestingModule({ providers: [{ provide: DeliveryApi, useValue: api }] });
    TestBed.inject(I18n).use('en');
    const fixture = TestBed.createComponent(BuildOutputPanel);
    fixture.componentRef.setInput('environment', environment);
    fixture.componentRef.setInput('applicationId', '0190f5a8-7b1c-7e2d-8f3a-0000000000dd');
    fixture.componentRef.setInput('deploymentId', '0190f5a8-7b1c-7e2d-8f3a-0000000000ee');
    fixture.componentRef.setInput('running', true);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);

    fixture.componentRef.setInput('running', false);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(3000);
    expect(reads).toBe(2);
    // This tick finds the read under way: it reads nothing and keeps its slot.
    await vi.advanceTimersByTimeAsync(3000);
    expect(reads).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(3000);
    expect(reads).toBe(3);
    // Two reads after the end, then none.
    await vi.advanceTimersByTimeAsync(9000);
    expect(reads).toBe(3);
    fixture.destroy();
  });
});
