import { inject, Pipe, type PipeTransform } from '@angular/core';

import { I18n } from './i18n';

const TYPES: Readonly<Record<string, string>> = {
  integer: 'un entier',
  number: 'un nombre',
  string: 'une chaîne',
  boolean: 'un booléen',
  object: 'un objet',
  array: 'une liste',
  null: 'null',
};
const OPERATORS: Readonly<Record<string, string>> = { '>=': '≥', '<=': '≤', '>': '>', '<': '<' };
const UNITS: Readonly<Record<string, string>> = {
  characters: 'caractères',
  items: 'éléments',
  properties: 'propriétés',
};

/** Patterns of the validator's English messages (Ajv's fixed templates and ours), in French. */
const FRENCH: readonly (readonly [RegExp, (match: RegExpExecArray) => string | null])[] = [
  [/^must have required property '(.+)'$/, (m) => `la propriété requise « ${m[1]} » manque`],
  [/^unknown key "(.+)"$/, (m) => `clé inconnue « ${m[1]} »`],
  [
    /^must match exactly one schema in oneOf$/,
    () => 'doit correspondre à une seule des formes possibles',
  ],
  [/^must match a schema in anyOf$/, () => "doit correspondre à l'une des formes possibles"],
  [/^must match "(?:then|else)" schema$/, () => 'ne respecte pas la condition attendue'],
  [/^must be equal to constant$/, () => 'doit être égal à la valeur attendue'],
  [/^must be equal to one of the allowed values$/, () => "doit être l'une des valeurs autorisées"],
  [/^must match pattern "(.+)"$/, (m) => `doit respecter le motif "${m[1]}"`],
  [/^must match format "(.+)"$/, (m) => `doit respecter le format "${m[1]}"`],
  [/^must be (>=|<=|>|<) (.+)$/, (m) => `doit être ${OPERATORS[m[1]]} ${m[2]}`],
  [/^must be multiple of (.+)$/, (m) => `doit être un multiple de ${m[1]}`],
  [/^must be ([a-z]+)$/, (m) => (m[1] in TYPES ? `doit être ${TYPES[m[1]]}` : null)],
  [
    /^must NOT have (more|fewer) than (\d+) (characters|items|properties)$/,
    (m) => `ne doit pas avoir ${m[1] === 'more' ? 'plus' : 'moins'} de ${m[2]} ${UNITS[m[3]]}`,
  ],
  [
    /^must NOT have duplicate items \(items ## (\d+) and (\d+) are identical\)$/,
    (m) => `ne doit pas contenir de doublon (éléments ${m[1]} et ${m[2]} identiques)`,
  ],
  [/^must NOT be valid$/, () => "n'est pas autorisé ici"],
  [/^must be at most (\d+) CPUs$/, (m) => `doit être au plus ${m[1]} CPU`],
  [/^must be between (\S+) and (\S+)$/, (m) => `doit être entre ${m[1]} et ${m[2]}`],
  [/^is too long to be counted$/, () => 'est trop long pour être compté'],
  [/^document exceeds (\d+) bytes$/, (m) => `le document dépasse ${m[1]} octets`],
  [/^invalid YAML$/, () => 'YAML invalide'],
];

/**
 * A configuration message in French (#273), or null for one it does not know (a YAML parser
 * message, say), which is then shown as written. English stays the source.
 */
export function frenchIssue(message: string): string | null {
  for (const [pattern, text] of FRENCH) {
    const match = pattern.exec(message);
    if (match) return text(match);
  }
  return null;
}

/** `{{ issue.message | issue }}`: the message in the interface language. */
@Pipe({ name: 'issue', pure: false })
export class IssueText implements PipeTransform {
  private readonly i18n = inject(I18n);
  transform(message: string): string {
    return this.i18n.language() === 'fr' ? (frenchIssue(message) ?? message) : message;
  }
}
