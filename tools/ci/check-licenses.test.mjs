// Run with: node --test tools/ci/check-licenses.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { checkLicenses, expressionAllowed, quoted } from './check-licenses.mjs';

const allowed = new Set(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC']);
const policy = {
  allowed: [...allowed],
  targets: ['pnpm-lock.yaml'],
  exceptions: [{ package: 'argparse', license: 'PSF-2.0', status: 'approved' }],
  undetected: [{ package: 'busboy', version: '1.6.0', license: 'MIT', reason: 'old field' }],
};
/** An inventory as Trivy writes it: one record per package version, with the licenses found. */
function report(packages, target = 'pnpm-lock.yaml') {
  return {
    Results: [
      {
        Target: target,
        Class: 'lang-pkgs',
        Packages: packages.map(([Name, Version, Licenses]) => ({
          Name,
          Version,
          Relationship: 'indirect',
          ...(Licenses ? { Licenses } : {}),
        })),
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
  // What it does not understand is not allowed, even beside an allowed license.
  for (const odd of [
    '',
    'MIT AND',
    '(MIT',
    'MIT)',
    'Apache-2.0 WITH LLVM-exception',
    'MIT ISC',
    'AND',
    'MIT OR ???',
    '??? OR MIT',
    'MIT OR see LICENSE file',
    'MIT OR ::error::x',
  ])
    assert.equal(expressionAllowed(odd, allowed), false, JSON.stringify(odd));
});

test('passes allowed licenses, approved exceptions and versions read by hand', () => {
  assert.deepEqual(
    checkLicenses(
      report([
        ['a', '1.0.0', ['MIT']],
        ['argparse', '3.0.4', ['PSF-2.0']],
        ['busboy', '1.6.0'],
      ]),
      policy,
    ),
    [],
  );
});

test('refuses a license outside the list, and an exception for another package', () => {
  const problems = checkLicenses(
    report([
      ['a', '1.0.0', ['GPL-3.0-only']],
      ['other', '1.0.0', ['PSF-2.0']],
      ['argparse', '3.0.4', ['GPL-3.0-only']],
    ]),
    policy,
  );
  assert.deepEqual(problems, [
    'license not allowed: package "a" version "1.0.0" in "pnpm-lock.yaml" license "GPL-3.0-only"',
    'license not allowed: package "other" version "1.0.0" in "pnpm-lock.yaml" license "PSF-2.0"',
    'license not allowed: package "argparse" version "3.0.4" in "pnpm-lock.yaml" license "GPL-3.0-only"',
  ]);
});

test('refuses an exception the maintainer has not approved yet, used by the report or not', () => {
  const withPending = {
    ...policy,
    exceptions: [...policy.exceptions, { package: 'elkjs', license: 'EPL-2.0', status: 'pending' }],
  };
  const pending =
    'exception pending the maintainer\u0027s approval in ADR 0014: package "elkjs" license "EPL-2.0"';
  assert.deepEqual(checkLicenses(report([['elkjs', '0.11.1', ['EPL-2.0']]]), withPending), [
    pending,
  ]);
  // The package is gone from the report: the entry still waits for its approval.
  assert.deepEqual(checkLicenses(report([['a', '1.0.0', ['MIT']]]), withPending), [pending]);
});

test('applies the rules to a license read by hand', () => {
  const read = (license) => ({
    ...policy,
    undetected: [{ package: 'old', version: '1.0.0', license, reason: 'old field' }],
  });
  assert.deepEqual(checkLicenses(report([['old', '1.0.0']]), read('MIT')), []);
  assert.deepEqual(checkLicenses(report([['old', '1.0.0']]), read('GPL-3.0-only')), [
    'license not allowed: package "old" version "1.0.0" in "pnpm-lock.yaml" license "GPL-3.0-only"',
  ]);
});

test('checks each version on its own', () => {
  // The license of one version never stands for another.
  assert.deepEqual(
    checkLicenses(
      report([
        ['lib', '1.0.0', ['MIT']],
        ['lib', '2.0.0'],
      ]),
      policy,
    ),
    ['no license found: package "lib" version "2.0.0" in "pnpm-lock.yaml"'],
  );
  // A version read by hand covers that version only.
  assert.deepEqual(checkLicenses(report([['busboy', '1.7.0']]), policy), [
    'no license found: package "busboy" version "1.7.0" in "pnpm-lock.yaml"',
  ]);
});

test('refuses a report without the expected inventories: a scan that saw nothing proves nothing', () => {
  assert.deepEqual(checkLicenses({ Results: [] }, policy), [
    'no dependency inventory for "pnpm-lock.yaml"',
  ]);
  assert.equal(checkLicenses({}, policy).length, 1);
  // Licenses alone, without the inventory, do not count.
  assert.deepEqual(
    checkLicenses(
      {
        Results: [
          { Target: 'pnpm-lock.yaml', Class: 'license', Licenses: [{ PkgName: 'a', Name: 'MIT' }] },
        ],
      },
      policy,
    ),
    ['no dependency inventory for "pnpm-lock.yaml"'],
  );
  // The module itself (root) is not a dependency.
  const own = report([]);
  own.Results[0].Packages = [{ Name: 'github.com/example/own', Relationship: 'root' }];
  assert.deepEqual(checkLicenses(own, policy), ['no dependency inventory for "pnpm-lock.yaml"']);
  // Another target's inventory does not stand for the expected one.
  assert.equal(checkLicenses(report([['a', '1.0.0', ['MIT']]], 'other.lock'), policy).length, 1);
});

test('escapes third-party text, so that the runner reads no command in it', () => {
  assert.equal(quoted('ok name-1.0_x+y/z@v'), '"ok name-1.0_x+y/z@v"');
  const [problem] = checkLicenses(report([['x', '1', ['\n::error::forged ##[group]']]]), policy);
  assert.ok(!problem.includes('\n'));
  assert.ok(!problem.includes('::'));
  assert.ok(!problem.includes('##['));
  assert.match(problem, /\\u000a\\u003a\\u003aerror/);
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
  assert.deepEqual(file.targets, ['pnpm-lock.yaml', 'agent/go.mod', 'cli/go.mod', 'lib/go.mod']);
  const adr = readFileSync(
    new URL('../../docs/adr/0014-dependency-license-exceptions.md', import.meta.url),
    'utf8',
  );
  // One row of the table per exception: package, license and approval are read from that row.
  const rows = adr.split('\n').filter((line) => line.startsWith('| '));
  for (const entry of file.exceptions) {
    const row = rows.find((line) => line.split('|')[1]?.includes(`\`${entry.package}\``));
    assert.ok(row, `${entry.package} has no row in ADR 0014`);
    assert.ok(
      row.split('|')[2]?.includes(entry.license),
      `${entry.package}: not ${entry.license} in ADR 0014`,
    );
    const pending = row.includes('pending maintainer approval');
    assert.equal(
      entry.status,
      pending ? 'pending' : 'approved',
      `${entry.package}: status differs from ADR 0014`,
    );
  }
  for (const entry of file.undetected) {
    // The version exactly as the report writes it: 1.6.0 for npm, v0.43.0 for Go.
    assert.equal(typeof entry.version, 'string', entry.package);
    assert.ok(entry.version.length > 0 && entry.version.trim() === entry.version, entry.package);
  }
});
