// Test cases for the TypeScript rules in .semgrep/shipkeep-rules.yml.
// Each `ruleid:` line must be flagged by the named rule; each `ok:` line must not.

// ruleid: ts-no-child-process
import { exec } from 'child_process';
// ruleid: ts-no-child-process
import { spawn } from 'node:child_process';
// ruleid: ts-no-child-process
import cp from 'child_process';
// ruleid: ts-no-child-process
import * as childProcess from 'node:child_process';
// ruleid: ts-no-child-process
import { execa } from 'execa';
// ruleid: ts-no-child-process
import shell from 'shelljs';
// ruleid: ts-no-child-process
import { $ } from 'zx';
// ruleid: ts-no-child-process
import spawnCross from 'cross-spawn';
// ruleid: ts-no-child-process
import * as pty from 'node-pty';
// ok: ts-no-child-process
import { readFile } from 'node:fs/promises';
// ok: ts-no-child-process
import { Injectable } from '@nestjs/common';

export async function loaders(): Promise<void> {
  // ruleid: ts-no-child-process
  const cp2 = require('child_process');
  // ruleid: ts-no-child-process
  const cp3 = await import('node:child_process');
  // ok: ts-no-child-process
  const path = await import('node:path');
  void [cp2, cp3, path, exec, spawn, cp, childProcess, execa, shell, $, spawnCross, pty, readFile, Injectable];
}

interface PrismaLike {
  $queryRawUnsafe(sql: string): Promise<unknown>;
  $executeRawUnsafe(sql: string): Promise<number>;
  $queryRaw(sql: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  $executeRaw(sql: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export async function prismaQueries(prisma: PrismaLike, orgId: string): Promise<void> {
  // ruleid: ts-no-prisma-unsafe-raw
  await prisma.$queryRawUnsafe(`SELECT * FROM nodes WHERE organization_id = '${orgId}'`);
  // ruleid: ts-no-prisma-unsafe-raw
  await prisma.$executeRawUnsafe('DELETE FROM nodes');

  // ok: ts-no-prisma-unsafe-raw
  await prisma.$queryRaw`SELECT * FROM nodes WHERE organization_id = ${orgId}`;
  // ok: ts-no-prisma-unsafe-raw
  await prisma.$executeRaw`UPDATE nodes SET status = 'down' WHERE id = ${orgId}`;
}

export function dynamicCode(source: string): void {
  // ruleid: ts-no-dynamic-code
  eval(source);
  // ruleid: ts-no-dynamic-code
  const fn = new Function('s', 'return import(s)');
  // ruleid: ts-no-dynamic-code
  const fn2 = Function('return 1');
  // ruleid: ts-no-dynamic-code
  setTimeout('doSomething()', 100);
  // ruleid: ts-no-dynamic-code
  setInterval('tick()', 1000);

  // ok: ts-no-dynamic-code
  setTimeout(() => dynamicCode(''), 100);
  // ok: ts-no-dynamic-code
  const parsed: unknown = JSON.parse(source);
  void [fn, fn2, parsed];
}
