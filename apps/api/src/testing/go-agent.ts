// Test tooling only: never imported by a production module. Fixed argv, no shell or secret args.
// nosemgrep: ts-no-child-process -- cross-language integration harness, analogous to tools/gen/openapi.mjs
import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const ROOT = resolve(__dirname, '../../../..');

/**
 * Compiles the agent's lifecycle test ahead of the run. With a cold build cache, compiling with the
 * race detector takes longer than the lifecycle's own time limits.
 */
export async function buildGoAgent(output: string): Promise<void> {
  await promisify(execFile)('go', ['test', '-race', '-c', '-o', output, './agent/internal/agent'], {
    cwd: ROOT,
    maxBuffer: 8 * 1024 * 1024,
  });
}

export function startGoAgent(binary: string, fixture: string, signal: AbortSignal): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(
      binary,
      ['-test.count=1', '-test.timeout=45s', '-test.run=^TestControlPlaneLifecycle$'],
      {
        cwd: resolve(ROOT, 'agent/internal/agent'),
        env: { ...process.env, SHIPKEEP_AGENT_TEST_FILE: fixture },
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    const collect = (data: Buffer) => {
      output = (output + data.toString()).slice(-32_768);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) accept();
      else reject(new Error(`Go agent integration failed (${String(code)}): ${output}`));
    });
  });
}
