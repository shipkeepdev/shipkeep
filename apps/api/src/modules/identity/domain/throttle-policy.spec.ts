import { throttlePolicy } from './throttle-policy';

describe('authentication throttle policy', () => {
  it('bounds expensive credential proofs and email delivery separately', () => {
    expect(throttlePolicy('login', 'ip')).toMatchObject({
      limit: 100,
      windowMs: 900000,
      progressive: false,
    });
    expect(throttlePolicy('login', 'subject')).toMatchObject({
      limit: 10,
      windowMs: 900000,
      progressive: true,
    });
    expect(throttlePolicy('email', 'subject')).toMatchObject({
      limit: 5,
      windowMs: 3600000,
      progressive: false,
    });
    expect(throttlePolicy('email', 'ip')).toMatchObject({ limit: 20, windowMs: 3600000 });
  });
});
