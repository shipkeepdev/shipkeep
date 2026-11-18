import type { HttpAdapterHost } from '@nestjs/core';

import { shouldDeliverMail } from './identity.module';

describe('who delivers the queued mail', () => {
  const serving = { httpAdapter: {} } as unknown as HttpAdapterHost;
  const standalone = { httpAdapter: undefined } as unknown as HttpAdapterHost;

  it('is the control plane that serves requests, when SMTP is configured', () => {
    expect(shouldDeliverMail('smtp.example.com', serving)).toBe(true);
  });

  it('is nobody without SMTP (ADR 0020)', () => {
    expect(shouldDeliverMail(undefined, serving)).toBe(false);
    expect(shouldDeliverMail('', serving)).toBe(false);
  });

  it('is never the command line of the operator, which serves nothing', () => {
    expect(shouldDeliverMail('smtp.example.com', standalone)).toBe(false);
    expect(shouldDeliverMail(undefined, standalone)).toBe(false);
  });
});
