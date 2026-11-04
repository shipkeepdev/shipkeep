// Test tooling only: never imported by a production module. Fixed argv, no shell or secret args.
// nosemgrep: ts-no-child-process -- cross-language integration harness, analogous to tools/gen/openapi.mjs
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export function startGoAgent(fixture: string, signal: AbortSignal): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(
      'go',
      [
        'test',
        '-race',
        '-count=1',
        '-timeout=45s',
        '-run',
        '^TestControlPlaneLifecycle$',
        './agent/internal/agent',
      ],
      {
        cwd: resolve(__dirname, '../../../..'),
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
