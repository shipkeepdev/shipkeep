import { frenchIssue } from './config-issue';

describe('configuration messages in French (#273)', () => {
  it('translates the validator messages users meet', () => {
    const cases: readonly (readonly [string, string])[] = [
      ["must have required property 'build'", 'la propriété requise « build » manque'],
      ['unknown key "prot"', 'clé inconnue « prot »'],
      [
        'must match exactly one schema in oneOf',
        'doit correspondre à une seule des formes possibles',
      ],
      ['must be equal to constant', 'doit être égal à la valeur attendue'],
      ['must be equal to one of the allowed values', "doit être l'une des valeurs autorisées"],
      ['must match pattern "^[a-z]+$"', 'doit respecter le motif "^[a-z]+$"'],
      ['must be >= 1', 'doit être ≥ 1'],
      ['must be integer', 'doit être un entier'],
      ['must be string', 'doit être une chaîne'],
      [
        'must NOT have duplicate items (items ## 0 and 1 are identical)',
        'ne doit pas contenir de doublon (éléments 0 et 1 identiques)',
      ],
      ['must NOT have more than 40 characters', 'ne doit pas avoir plus de 40 caractères'],
      ['must NOT have fewer than 1 items', 'ne doit pas avoir moins de 1 éléments'],
      ['must NOT be valid', "n'est pas autorisé ici"],
      ['must be at most 256 CPUs', 'doit être au plus 256 CPU'],
      ['must be between 6Mi and 1Ti', 'doit être entre 6Mi et 1Ti'],
      ['document exceeds 65536 bytes', 'le document dépasse 65536 octets'],
    ];
    for (const [english, french] of cases) expect(frenchIssue(english)).toBe(french);
  });

  it('leaves unknown messages, such as YAML parser ones, as written', () => {
    expect(
      frenchIssue('Flow sequence in block collection must be sufficiently indented'),
    ).toBeNull();
    expect(frenchIssue('must be purple')).toBeNull();
  });
});
