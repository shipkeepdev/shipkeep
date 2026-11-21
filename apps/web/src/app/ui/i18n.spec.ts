import { TestBed } from '@angular/core/testing';

import { I18n } from './i18n';

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
