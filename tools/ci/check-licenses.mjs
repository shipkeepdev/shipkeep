#!/usr/bin/env node
// Checks the licenses of the production dependencies against tools/ci/licenses.json.
// Usage: check-licenses.mjs <trivy-license-report.json> <licenses.json>
//
// The report comes from `trivy fs --scanners license --format json` on a checkout whose
// node_modules and Go module cache are populated: Trivy reads licenses from them, not from the
// lockfiles. Package names and license texts come from third-party metadata: they are printed as
// JSON strings after a fixed prefix, so that none of them can start a workflow command in the log.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Whether an SPDX-like expression is acceptable: `A OR B` needs one side allowed, `A AND B` both.
 * Trivy also reports lowercase `and`/`or` copied from package metadata.
 */
export function expressionAllowed(expression, allowed) {
  const tokens = expression
    .replace(/[()]/g, (bracket) => ` ${bracket} `)
    .split(/\s+/)
    .filter(Boolean);
  let position = 0;
  const peek = () => tokens[position];
  const operator = (name) => peek()?.toUpperCase() === name;
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
    if (token === ')' || ['AND', 'OR', 'WITH'].includes(token.toUpperCase()))
      throw new Error(`unexpected ${token}`);
    return allowed.has(token);
  };
  try {
    const value = parseOr();
    // Anything left over (an exception clause with WITH, stray words) is not understood.
    return position === tokens.length && value;
  } catch {
    return false;
  }
}

/** The problems of a report under a policy: one line of text each, empty when all is well. */
export function checkLicenses(report, policy) {
  const allowed = new Set(policy.allowed);
  const exceptions = new Set(
    policy.exceptions.map((entry) => `${entry.package}\u0000${entry.license}`),
  );
  const undetected = new Set(policy.undetected.map((entry) => entry.package));
  const problems = [];
  const results = Array.isArray(report?.Results) ? report.Results : [];
  if (results.length === 0) problems.push('the report holds no results: nothing was scanned');

  const licensed = new Map();
  for (const result of results) {
    if (result.Class !== 'license') continue;
    for (const finding of result.Licenses ?? []) {
      const key = `${result.Target}\u0000${finding.PkgName}`;
      licensed.set(key, true);
      if (expressionAllowed(finding.Name, allowed)) continue;
      if (exceptions.has(`${finding.PkgName}\u0000${finding.Name}`)) continue;
      problems.push(
        `license not allowed: package ${JSON.stringify(finding.PkgName)} license ${JSON.stringify(finding.Name)} in ${JSON.stringify(result.Target)}`,
      );
    }
  }
  // A dependency whose license Trivy found nowhere is a gap, not a pass.
  for (const result of results) {
    if (result.Class !== 'lang-pkgs') continue;
    for (const pkg of result.Packages ?? []) {
      if (pkg.Relationship === 'root') continue;
      if (licensed.has(`${result.Target}\u0000${pkg.Name}`)) continue;
      if (undetected.has(pkg.Name)) continue;
      problems.push(
        `no license found: package ${JSON.stringify(pkg.Name)} version ${JSON.stringify(pkg.Version ?? '')} in ${JSON.stringify(result.Target)}`,
      );
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [reportPath, policyPath] = process.argv.slice(2);
  if (!reportPath || !policyPath) {
    console.error('usage: check-licenses.mjs <trivy-license-report.json> <licenses.json>');
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const problems = checkLicenses(report, policy);
  const pending = policy.exceptions.filter((entry) => entry.status !== 'approved');
  for (const entry of pending)
    console.log(
      `pending approval in ADR 0014: package ${JSON.stringify(entry.package)} license ${JSON.stringify(entry.license)}`,
    );
  for (const problem of problems) console.log(`license check: ${problem}`);
  if (problems.length > 0) {
    console.log(
      'license check failed. Replace the dependency, or record an exception in docs/adr/0014-dependency-license-exceptions.md and tools/ci/licenses.json, approved by the maintainer.',
    );
    process.exit(1);
  }
  console.log('license check passed.');
}
