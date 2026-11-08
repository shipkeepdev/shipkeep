import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { ConfigService } from '@nestjs/config';

import { issueToken } from '../modules/identity/infrastructure/identity-secrets';
import { SmtpIdentityDelivery } from '../modules/identity/infrastructure/smtp-identity-delivery';
import { AppConfig } from '../platform/config/app-config';
import { parseConfig, type ParsedConfig } from '../platform/config/config.schema';

interface DevMailServer {
  readonly port: number;
  close: () => Promise<void>;
}
interface DevMailModule {
  devMailSettings: (
    env: Record<string, string | undefined>,
  ) => { port: number; caFile: string } | undefined;
  startDevMailServer: (options: {
    port: number;
    caFile: string;
    print: (text: string) => void;
  }) => Promise<DevMailServer>;
}

const modulePath = resolve(__dirname, '../../../../tools/dev/mail.mjs');
const moduleUrl = pathToFileURL(modulePath).href;

describe('development mail server', () => {
  let mail: DevMailModule;
  let directory: string;
  let caFile: string;
  let printed: string[];
  let server: DevMailServer;

  beforeAll(async () => {
    mail = (await import(/* @vite-ignore */ moduleUrl)) as DevMailModule;
  });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'shipkeep-dev-mail-'));
    caFile = join(directory, 'secrets', 'mail-ca.crt');
    printed = [];
    server = await mail.startDevMailServer({
      port: 0,
      caFile,
      print: (text) => printed.push(text),
    });
  });
  afterEach(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  function deliver() {
    return new SmtpIdentityDelivery(
      new AppConfig(
        new ConfigService<ParsedConfig, true>(
          parseConfig({
            DATABASE_URL: 'postgresql://test:test@localhost/test',
            SHIPKEEP_KEK_FILE: '/unused/test/kek',
            API_PUBLIC_URL: 'http://localhost:4200',
            SMTP_HOST: 'localhost',
            SMTP_PORT: String(server.port),
            SMTP_FROM: 'notifications@example.com',
            SMTP_CA_FILE: caFile,
          }),
        ),
      ),
    );
  }

  /** Speaks raw SMTP over TLS, trusting the certificate the server wrote. */
  async function send(lines: string[]): Promise<void> {
    const socket = connect({
      host: 'localhost',
      port: server.port,
      ca: await readFile(caFile),
      servername: 'localhost',
    });
    await new Promise<void>((done, fail) => {
      socket.once('secureConnect', () => {
        socket.write(lines.map((line) => `${line}\r\n`).join(''));
      });
      socket.once('close', () => {
        done();
      });
      socket.on('error', (error: NodeJS.ErrnoException) => {
        // The server resets connections it drops on purpose.
        if (error.code !== 'ECONNRESET') fail(error);
      });
      socket.on('data', () => undefined);
    });
  }

  it('receives a real verification email over verified TLS and prints the code', async () => {
    const token = issueToken();

    await deliver().deliver({
      email: 'person@example.com',
      purpose: 'verify',
      token,
      expiresAt: new Date(Date.now() + 3600000),
    });

    const output = printed.join('\n');
    expect(output).toContain('person@example.com');
    expect(output).toContain('Subject: Shipkeep: verify your email');
    expect(output).toContain('http://localhost:4200/verify-email');
    expect(output).toContain(token.expose());
  });

  it('removes terminal control characters from what it prints', async () => {
    await send([
      'DATA',
      'To: a\u001b]0;owned\u0007@example.com',
      '',
      'hello\u001b[2Jworld',
      '.',
      'QUIT',
    ]);

    const output = printed.join('\n');
    expect(output).toContain('hello[2Jworld');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0007');
  });

  it('drops a connection that sends an oversized message and keeps running', async () => {
    const line = 'x'.repeat(1024);
    await send(['DATA', ...Array.from({ length: 2048 }, () => line), '.', 'QUIT']);

    expect(printed).toEqual([]);
    await send(['DATA', 'To: next@example.com', '', 'still alive', '.', 'QUIT']);
    expect(printed.join('\n')).toContain('still alive');
  });

  it('counts empty lines toward the message limit', async () => {
    await send(['DATA', ...Array.from({ length: 300000 }, () => ''), '.', 'QUIT']);

    expect(printed).toEqual([]);
  });

  it('counts bytes, not characters, toward the message limit', async () => {
    const line = '\u20ac'.repeat(341);
    await send(['DATA', ...Array.from({ length: 600 }, () => line), '.', 'QUIT']);

    expect(printed).toEqual([]);
  });

  it('loads without the polyfills the test runner provides', async () => {
    const exitCode = await new Promise<number>((done, fail) => {
      // Imported, not run as the main script, so it can never start a server here.
      new Worker(`import(${JSON.stringify(moduleUrl)})`, { eval: true })
        .once('error', fail)
        .once('exit', done);
    });

    expect(exitCode).toBe(0);
  });

  it('only runs for a loopback development configuration', () => {
    const devCaFile = './deploy/dev/secrets/mail-ca.crt';
    const env = { SMTP_HOST: 'localhost', SMTP_PORT: '1465', SMTP_CA_FILE: devCaFile };

    expect(mail.devMailSettings(env)).toEqual({ port: 1465, caFile: devCaFile });
    expect(mail.devMailSettings({ ...env, SMTP_CA_FILE: '/etc/ssl/relay-ca.crt' })).toBeUndefined();
    expect(mail.devMailSettings({ ...env, SMTP_HOST: 'smtp.example.com' })).toBeUndefined();
    expect(mail.devMailSettings({ ...env, SMTP_HOST: undefined })).toBeUndefined();
    expect(mail.devMailSettings({ ...env, SMTP_CA_FILE: undefined })).toBeUndefined();
    expect(() => mail.devMailSettings({ ...env, NODE_ENV: 'production' })).toThrow();
  });
});
