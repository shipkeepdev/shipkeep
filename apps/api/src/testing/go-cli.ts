// Test tooling only: never imported by a production module. Fixed argv, no shell, no secret args.
// nosemgrep: ts-no-child-process -- cross-language integration harness, analogous to go-agent.ts
import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Builds the real CLI, so the test exercises what users run. */
export async function buildCli(output: string): Promise<void> {
  await promisify(execFile)('go', ['build', '-o', output, './cli/cmd/shipkeep'], {
    cwd: resolve(__dirname, '../../../..'),
  });
}

/** Secrets go through standard input, as the CLI requires: never as an argument. */
export function runCli(
  binary: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  cwd: string,
  input = '',
): Promise<CliResult> {
  return new Promise((accept, reject) => {
    const child = spawn(binary, [...args], {
      cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
    child.once('error', reject);
    child.once('close', (code) => {
      accept({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
