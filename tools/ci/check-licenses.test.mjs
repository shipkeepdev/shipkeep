// Run with: node --test tools/ci/check-licenses.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { checkLicenses, expressionAllowed } from './check-licenses.mjs';

const allowed = new Set(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC']);
const policy = {
  allowed: [...allowed],
  exceptions: [{ package: 'argparse', license: 'PSF-2.0', status: 'approved' }],
  undetected: [{ package: 'busboy', license: 'MIT', reason: 'old licenses array' }],
};
/** A report as Trivy writes it: package results, then license results for the same target. */
function report(packages, licenses, target = 'pnpm-lock.yaml') {
  return {
    Results: [
      {
        Target: target,
        Class: 'lang-pkgs',
        Packages: packages.map((Name) => ({ Name, Version: '1.0.0', Relationship: 'indirect' })),
      },
      {
        Target: target,
        Class: 'license',
        Licenses: licenses.map(([PkgName, Name]) => ({ PkgName, Name })),
      },
    ],
  };
}

test('reads the license expressions found in package metadata', () => {
  assert.equal(expressionAllowed('MIT', allowed), true);
  assert.equal(expressionAllowed('GPL-3.0-only', allowed), false);
  // OR: one side is enough. AND: both are needed. Lowercase words come from package.json.
  assert.equal(expressionAllowed('(MIT OR CC0-1.0)', allowed), true);
  assert.equal(expressionAllowed('(GPL-2.0-only OR CC0-1.0)', allowed), false);
  assert.equal(expressionAllowed('(Apache-2.0 AND BSD-3-Clause)', allowed), true);
  assert.equal(expressionAllowed('(Apache-2.0 AND GPL-2.0-only)', allowed), false);
  assert.equal(expressionAllowed('MIT and ISC', allowed), true);
  assert.equal(expressionAllowed('MIT or GPL-3.0-only', allowed), true);
  assert.equal(expressionAllowed('(MIT AND (ISC OR GPL-3.0-only))', allowed), true);
  // What it does not understand is not allowed.
  for (const odd of [
    '',
    'MIT AND',
    '(MIT',
    'MIT)',
    'Apache-2.0 WITH LLVM-exception',
    'MIT ISC',
    'AND',
  ])
    assert.equal(expressionAllowed(odd, allowed), false, JSON.stringify(odd));
});

test('passes allowed licenses and recorded exceptions', () => {
  assert.deepEqual(
    checkLicenses(
      report(
        ['a', 'argparse', 'busboy'],
        [
          ['a', 'MIT'],
          ['argparse', 'PSF-2.0'],
        ],
      ),
      policy,
    ),
    [],
  );
});

test('refuses a license outside the list, and an exception for another package', () => {
  const problems = checkLicenses(
    report(
      ['a', 'other'],
      [
        ['a', 'GPL-3.0-only'],
        ['other', 'PSF-2.0'],
      ],
    ),
    policy,
  );
  assert.equal(problems.length, 2);
  assert.match(problems[0], /license not allowed: package "a" license "GPL-3.0-only"/);
  assert.match(problems[1], /package "other" license "PSF-2.0"/);
  // The exception is for that package with that license only.
  assert.equal(
    checkLicenses(report(['argparse'], [['argparse', 'GPL-3.0-only']]), policy).length,
    1,
  );
});

test('refuses a dependency whose license was found nowhere, except the ones verified by hand', () => {
  const problems = checkLicenses(report(['a', 'b', 'busboy'], [['a', 'MIT']]), policy);
  // The version says which copy was looked for: Go reads it from the module cache.
  assert.deepEqual(problems, ['no license found: package "b" version "1.0.0" in "pnpm-lock.yaml"']);
  // The module itself (root) carries no dependency license.
  const own = report([], []);
  own.Results[0].Packages = [{ Name: 'github.com/example/own', Relationship: 'root' }];
  assert.deepEqual(checkLicenses(own, policy), []);
});

test('refuses an empty report: a scan that saw nothing proves nothing', () => {
  assert.deepEqual(checkLicenses({ Results: [] }, policy), [
    'the report holds no results: nothing was scanned',
  ]);
  assert.equal(checkLicenses({}, policy).length, 1);
});

test('quotes third-party text, so that it cannot start a line of the log', () => {
  const [problem] = checkLicenses(report(['x'], [['x', '\n::error::forged']]), policy);
  assert.ok(!problem.includes('\n'));
  assert.match(problem, /license "\\n::error::forged"/);
});

test('the policy lists the allowed licenses of CLAUDE.md and the exceptions of ADR 0014', () => {
  const file = JSON.parse(readFileSync(new URL('./licenses.json', import.meta.url), 'utf8'));
  assert.deepEqual(file.allowed, [
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    'MPL-2.0',
  ]);
  const adr = readFileSync(
    new URL('../../docs/adr/0014-dependency-license-exceptions.md', import.meta.url),
    'utf8',
  );
  for (const entry of file.exceptions) {
    assert.ok(adr.includes(`\`${entry.package}\``), `${entry.package} is not in ADR 0014`);
    assert.ok(adr.includes(entry.license), `${entry.license} is not in ADR 0014`);
    assert.ok(['approved', 'pending'].includes(entry.status), entry.package);
  }
});
