import { describeDevice } from './device';

describe('describeDevice', () => {
  it.each([
    [
      'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
      { browser: 'Firefox', system: 'Linux' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      { browser: 'Edge', system: 'Windows' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      { browser: 'Safari', system: 'macOS' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1',
      { browser: 'Chrome', system: 'iOS' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
      { browser: 'Chrome', system: 'Android' },
    ],
    ['curl/8.5.0', { browser: 'curl', system: null }],
    ['', { browser: null, system: null }],
  ])('reads %s', (agent, device) => {
    expect(describeDevice(agent)).toEqual(device);
  });

  it('never returns the client text itself', () => {
    expect(describeDevice('<script>alert(1)</script> Linux')).toEqual({
      browser: null,
      system: 'Linux',
    });
    expect(describeDevice('x'.repeat(512))).toEqual({ browser: null, system: null });
  });
});
