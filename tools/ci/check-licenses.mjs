#!/usr/bin/env node
// Checks the licenses of the production dependencies against tools/ci/licenses.json.
// Usage: check-licenses.mjs <trivy-license-report.json> <licenses.json>
//
// The report comes from `trivy fs --scanners license --format json` on a checkout whose
// node_modules and Go module cache are populated: Trivy reads licenses from them, not from the
// lockfiles. Each package record (name, version, licenses) is checked on its own, so the license of
// one version never stands for another. Package names and license texts are third-party metadata:
// they are printed escaped, so that none of them can be read as a workflow command.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** An SPDX license identifier, or a LicenseRef. Anything else is not understood. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

/**
 * Whether an SPDX-like expression is acceptable: `A OR B` needs one side allowed, `A AND B` both.
 * Trivy also reports lowercase `and`/`or` copied from package metadata. An expression that does not
 * parse, or holds an operand that is not an identifier, is refused whatever else it holds.
 */
export function expressionAllowed(expression, allowed) {
  const tokens = String(expression)
    .replace(/[()]/g, (bracket) => ` ${bracket} `)
    .split(/\s+/)
    .filter(Boolean);
  let position = 0;
  const operator = (name) => tokens[position]?.toUpperCase() === name;
  // or := and ('OR' and)* ; and := atom ('AND' atom)* ; atom := '(' or ')' | identifier
  const parseOr = () => {
    let value = parseAnd();
    while (operator('OR')) {
      position++;
      const right = parseAnd();
      value = value || right;
    }
    return value;
  };
  const parseAnd = () => {
    let value = parseAtom();
    while (operator('AND')) {
      position++;
      const right = parseAtom();
      value = value && right;
    }
    return value;
  };
  const parseAtom = () => {
    const token = tokens[position++];
    if (token === undefined) throw new Error('unexpected end');
    if (token === '(') {
      const value = parseOr();
      if (tokens[position++] !== ')') throw new Error('missing )');
      return value;
    }
    if (['AND', 'OR', 'WITH'].includes(token.toUpperCase()) || !IDENTIFIER.test(token))
      throw new Error('not an identifier');
    return allowed.has(token);
  };
  try {
    // The whole expression is parsed before its value counts: a malformed operand on the losing
    // side of an OR still makes it unreadable.
    const value = parseOr();
    return position === tokens.length && value;
  } catch {
    return false;
  }
}

/**
 * Third-party text for the log, in double quotes. Letters, digits and a few signs are kept; every
 * other character (colons, brackets, quotes, control and non-ASCII characters) is written as
 * \uXXXX, so that no marker the Actions runner reads as a command can appear.
 */
export function quoted(text) {
  let escaped = '';
  for (let index = 0; index < String(text).length; index++) {
    const unit = String(text)[index];
    escaped += /^[A-Za-z0-9 ._+/@-]$/.test(unit)
      ? unit
      : `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`;
  }
  return `"${escaped}"`;
}

/** The problems of a report under a policy: one line of text each, empty when all is well. */
export function checkLicenses(report, policy) {
  const allowed = new Set(policy.allowed);
  const exceptions = new Map(
    policy.exceptions.map((entry) => [`${entry.package}\u0000${entry.license}`, entry]),
  );
  const undetected = new Set(
    policy.undetected.map((entry) => `${entry.package}\u0000${entry.version}`),
  );
  const problems = [];
  const results = Array.isArray(report?.Results) ? report.Results : [];

  // Every expected inventory must be there and hold packages: a report without them proves
  // nothing, whatever licenses it holds.
  for (const target of policy.targets) {
    const inventory = results.find(
      (result) => result.Class === 'lang-pkgs' && result.Target === target,
    );
    const packages = (inventory?.Packages ?? []).filter((pkg) => pkg.Relationship !== 'root');
    if (packages.length === 0) problems.push(`no dependency inventory for ${quoted(target)}`);
  }

  for (const result of results) {
    if (result.Class !== 'lang-pkgs') continue;
    for (const pkg of result.Packages ?? []) {
      if (pkg.Relationship === 'root') continue;
      const where = `package ${quoted(pkg.Name)} version ${quoted(pkg.Version ?? '')} in ${quoted(result.Target)}`;
      const licenses = Array.isArray(pkg.Licenses) ? pkg.Licenses : [];
      if (licenses.length === 0) {
        // Found nowhere: a gap, not a pass, unless that exact version was read by hand.
        if (!undetected.has(`${pkg.Name}\u0000${pkg.Version}`))
          problems.push(`no license found: ${where}`);
        continue;
      }
      for (const license of licenses) {
        if (expressionAllowed(license, allowed)) continue;
        const exception = exceptions.get(`${pkg.Name}\u0000${license}`);
        if (exception?.status === 'approved') continue;
        problems.push(
          exception
            ? `exception pending the maintainer's approval in ADR 0014: ${where} license ${quoted(license)}`
            : `license not allowed: ${where} license ${quoted(license)}`,
        );
      }
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [reportPath, policyPath] = process.argv.slice(2);
  if (!reportPath || !policyPath) {
    console.error('usage: check-licenses.mjs <trivy-license-report.json> <licenses.json>');
    process.exitCode = 2;
  } else {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    const problems = checkLicenses(report, policy);
    for (const problem of problems) console.log(`license check: ${problem}`);
    if (problems.length > 0) {
      console.log(
        'license check failed. Replace the dependency, or record an exception in docs/adr/0014-dependency-license-exceptions.md and tools/ci/licenses.json, approved by the maintainer.',
      );
      // exitCode, not exit(): the lines above may still be on their way through a pipe.
      process.exitCode = 1;
    } else {
      console.log('license check passed.');
    }
  }
}
