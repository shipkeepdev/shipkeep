import { DOCUMENT } from '@angular/common';
import { effect, inject, Injectable, Pipe, type PipeTransform, signal } from '@angular/core';

import { FR } from './fr';

export type Language = 'en' | 'fr';
export const LANGUAGES: readonly Language[] = ['en', 'fr'];
const KEY = 'shipkeep-lang';

function stored(): Language | null {
  try {
    const value = globalThis.localStorage.getItem(KEY);
    return value === 'en' || value === 'fr' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The interface language: the choice saved in this browser, otherwise the browser's language.
 * English is the source text; `t()` looks up the French copy and fills `{name}` placeholders.
 */
@Injectable({ providedIn: 'root' })
export class I18n {
  private readonly document = inject(DOCUMENT);
  readonly language = signal<Language>(
    stored() ?? (globalThis.navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en'),
  );

  constructor() {
    effect(() => {
      this.document.documentElement.lang = this.language();
    });
  }

  use(language: Language): void {
    try {
      globalThis.localStorage.setItem(KEY, language);
    } catch {
      // Private windows may refuse storage; the choice then lasts for this page only.
    }
    this.language.set(language);
  }

  t(text: string, values?: Readonly<Record<string, string | number>>): string {
    const template = this.language() === 'fr' ? (FR[text] ?? text) : text;
    if (!values) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in values ? String(values[name]) : match,
    );
  }

  /**
   * A count with the form its language gives it: "1 project" and "0 projects" in English, "0 projet"
   * and "2 projets" in French. `one` and `other` are English source texts with an `{n}`, and may use
   * other `values`; an unknown count (null) shows a dash with the plural form.
   */
  count(
    n: number | null,
    one: string,
    other: string,
    values?: Readonly<Record<string, string | number>>,
  ): string {
    const single = n !== null && new Intl.PluralRules(this.language()).select(n) === 'one';
    return this.t(single ? one : other, { ...values, n: n ?? '—' });
  }

  /**
   * A date in the interface language (#273): 'medium' (date and time), 'mediumDate' or
   * 'shortTime'. An empty or unreadable value gives an empty string.
   */
  date(value: string | null | undefined, style: DateStyle = 'medium'): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(
      this.language() === 'fr' ? 'fr-FR' : 'en-US',
      DATE_STYLES[style],
    ).format(date);
  }

  /** Numbers in the interface language: 5,920 in English, 5 920 in French. */
  number(value: number, digits = 0): string {
    return value.toLocaleString(this.language() === 'fr' ? 'fr-FR' : 'en-US', {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    });
  }
}

export type DateStyle = 'medium' | 'mediumDate' | 'shortTime';
const DATE_STYLES: Readonly<Record<DateStyle, Intl.DateTimeFormatOptions>> = {
  medium: { dateStyle: 'medium', timeStyle: 'medium' },
  mediumDate: { dateStyle: 'medium' },
  shortTime: { timeStyle: 'short' },
};

/** `{{ value | localDate: 'mediumDate' }}`. Not pure: a language switch re-renders it. */
@Pipe({ name: 'localDate', pure: false })
export class LocalDate implements PipeTransform {
  private readonly i18n = inject(I18n);
  transform(value: string | null | undefined, style: DateStyle = 'medium'): string {
    return this.i18n.date(value, style);
  }
}

/** `{{ 'Overview' | t }}`. Not pure: it reads the language signal, so a switch re-renders. */
@Pipe({ name: 't', pure: false })
export class T implements PipeTransform {
  private readonly i18n = inject(I18n);
  transform(
    text: string | null | undefined,
    values?: Readonly<Record<string, string | number>>,
  ): string {
    return text ? this.i18n.t(text, values) : '';
  }
}

/**
 * `{{ n | count: '{n} project' : '{n} projects' }}`: the form the interface language gives `n`.
 * Not pure: it reads the language signal, so a switch re-renders.
 */
@Pipe({ name: 'count', pure: false })
export class Count implements PipeTransform {
  private readonly i18n = inject(I18n);
  transform(
    n: number | null | undefined,
    one: string,
    other: string,
    values?: Readonly<Record<string, string | number>>,
  ): string {
    return this.i18n.count(n ?? null, one, other, values);
  }
}
