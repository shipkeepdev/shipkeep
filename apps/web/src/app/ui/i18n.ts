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

  /** Numbers in the interface language: 5,920 in English, 5 920 in French. */
  number(value: number, digits = 0): string {
    return value.toLocaleString(this.language() === 'fr' ? 'fr-FR' : 'en-US', {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    });
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
