/** The browser and the system behind a session, each null when the User-Agent names none known. */
export interface Device {
  readonly browser: string | null;
  readonly system: string | null;
}

/**
 * The device behind a session, read from its User-Agent header: a known browser and a known
 * system, such as Firefox and Linux. The header is the client's own text, so only names from the
 * lists below come out of it, never the header itself.
 */
export function describeDevice(userAgent: string): Device {
  return {
    browser: BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null,
    system: SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null,
  };
}

// Order matters: Edge and Opera also say Chrome, Chrome also says Safari.
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\b(OPR|Opera)\//, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrom(e|ium)\/|\bCriOS\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*Safari\//, 'Safari'],
  [/\bcurl\//, 'curl'],
  [/\bshipkeep-cli\//, 'Shipkeep CLI'],
];
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\b(iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\b(Macintosh|Mac OS X)\b/, 'macOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b/, 'Linux'],
];
