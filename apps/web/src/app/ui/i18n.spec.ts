import { TestBed } from '@angular/core/testing';

import { Count, I18n } from './i18n';

// The language is kept in localStorage: put it back, or later files read French.
afterEach(() => {
  try {
    localStorage.removeItem('shipkeep-lang');
  } catch {
    // No storage: nothing was kept.
  }
});

describe('I18n.count', () => {
  it('gives each count the form of its language, and a dash to an unknown one', () => {
    const i18n = TestBed.inject(I18n);
    i18n.use('en');
    expect(i18n.count(0, '{n} project', '{n} projects')).toBe('0 projects');
    expect(i18n.count(1, '{n} project', '{n} projects')).toBe('1 project');
    expect(i18n.count(2, '{n} project', '{n} projects')).toBe('2 projects');
    expect(i18n.count(null, '{n} member', '{n} members')).toBe('— members');
    i18n.use('fr');
    // French counts zero as singular.
    expect(i18n.count(0, '{n} project', '{n} projects')).toBe('0 projet');
    expect(i18n.count(1, '{n} server', '{n} servers')).toBe('1 serveur');
    expect(i18n.count(3, '{n} environment', '{n} environments')).toBe('3 environnements');
  });
});

describe('count pipe', () => {
  it('reads the language and keeps the other values', () => {
    const i18n = TestBed.inject(I18n);
    const count = TestBed.runInInjectionContext(() => new Count());
    i18n.use('en');
    expect(
      count.transform(1, '{running} of {n} replica running', '{running} of {n} replicas running', {
        running: 0,
      }),
    ).toBe('0 of 1 replica running');
    expect(count.transform(undefined, '{n} agent', '{n} agents')).toBe('— agents');
    i18n.use('fr');
    expect(count.transform(0, '{n} agent connected · mTLS', '{n} agents connected · mTLS')).toBe(
      '0 agent connecté · mTLS',
    );
  });

  it('formats dates in the interface language (#273)', () => {
    const i18n = TestBed.inject(I18n);
    // Local time: the same calendar day in every time zone the tests run in.
    const at = '2026-11-21T12:00:00';
    i18n.use('en');
    expect(i18n.date(at, 'mediumDate')).toMatch(/Nov 21, 2026/);
    i18n.use('fr');
    expect(i18n.date(at, 'mediumDate')).toMatch(/21 nov\. 2026/);
    expect(i18n.date(null)).toBe('');
    expect(i18n.date('not a date')).toBe('');
  });
});
