// Local development only. An SMTP server that prints emails in the terminal instead of sending
// them, so that nobody needs a real mail account to sign up. It listens on loopback only, and its
// private key stays in memory. The API still verifies TLS: it trusts the certificate written here.
// @peculiar/x509 needs this polyfill to be loaded first.
import 'reflect-metadata';

import { webcrypto } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:tls';
import { fileURLToPath } from 'node:url';

import * as x509 from '@peculiar/x509';

const MAX_LINE_BUFFER = 64 * 1024;
const MAX_MESSAGE = 512 * 1024;
const ONE_YEAR = 365 * 24 * 60 * 60 * 1000;
const DEV_CA_FILE = 'deploy/dev/secrets/mail-ca.crt';

/** The server's settings, or undefined when `.env` points at a real mail provider. */
export function devMailSettings(env) {
  if (env.NODE_ENV === 'production')
    throw new Error('The development mail server cannot run in production.');
  // Only this file is ours to overwrite: any other CA bundle belongs to a real local relay.
  if (env.SMTP_HOST !== 'localhost' || !env.SMTP_CA_FILE) return undefined;
  if (resolve(env.SMTP_CA_FILE) !== resolve(DEV_CA_FILE)) return undefined;
  return { port: Number(env.SMTP_PORT ?? 465), caFile: env.SMTP_CA_FILE };
}

async function localhostCertificate() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      name: 'CN=localhost',
      keys,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + ONE_YEAR),
      extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'localhost' }])],
    },
    webcrypto,
  );
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const body =
    der
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? '';
  const label = 'PRIVATE KEY';
  return {
    key: `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`,
    cert: cert.toString('pem'),
  };
}

/** Message text can hold anything, so nothing it contains may drive the terminal. */
function printable(text) {
  return [...text]
    .filter((character) => {
      const code = character.codePointAt(0);
      return code === 10 || (code >= 32 && code !== 127 && (code < 128 || code > 159));
    })
    .join('');
}

/** Mail clients send `=?UTF-8?Q?...?=` for headers; show the text instead. */
function decodeHeader(value) {
  return value.replace(/=\?UTF-8\?Q\?([^?]*)\?=/gi, (_, text) =>
    Buffer.from(
      text
        .replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (__, hex) => String.fromCharCode(parseInt(hex, 16))),
      'latin1',
    ).toString('utf8'),
  );
}

function render(lines) {
  const end = lines.indexOf('');
  const headers = end < 0 ? lines : lines.slice(0, end);
  const body = end < 0 ? [] : lines.slice(end + 1);
  const header = (name) =>
    headers
      .find((line) => line.toLowerCase().startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .trim() ?? '';
  const text = [
    `To: ${header('to')}`,
    `Subject: ${decodeHeader(header('subject'))}`,
    '',
    ...body,
  ].join('\n');
  return printable(
    `\n----- Email (not sent) -----\n${text.trim()}\n----------------------------\n`,
  );
}

function answer(socket, line) {
  if (/^EHLO /i.test(line)) socket.write('250 localhost\r\n');
  else if (/^HELO /i.test(line)) socket.write('250 localhost\r\n');
  else if (/^AUTH /i.test(line)) socket.write('235 accepted\r\n');
  else if (line.toUpperCase() === 'QUIT') socket.end('221 bye\r\n');
  else socket.write('250 ok\r\n');
}

/** Binds to 127.0.0.1 and writes the public certificate to `caFile` for the API to trust. */
export async function startDevMailServer({ port, caFile, print }) {
  const tls = await localhostCertificate();
  const path = resolve(caFile);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, tls.cert, { mode: 0o600 });
  await chmod(path, 0o600);

  const sockets = new Set();
  const server = createServer(tls, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    socket.write('220 localhost Shipkeep development mail\r\n');
    let pending = '';
    let message;
    let size = 0;
    socket.on('data', (chunk) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_LINE_BUFFER) {
        socket.destroy();
        return;
      }
      let boundary;
      while ((boundary = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (!message) {
          if (line.toUpperCase() === 'DATA') {
            message = [];
            size = 0;
            socket.write('354 send data\r\n');
          } else answer(socket, line);
        } else if (line === '.') {
          print(render(message));
          message = undefined;
          socket.write('250 accepted\r\n');
        } else {
          size += Buffer.byteLength(line) + 2;
          if (size > MAX_MESSAGE) {
            socket.destroy();
            return;
          }
          message.push(line.startsWith('.') ? line.slice(1) : line);
        }
      }
    });
  });
  server.on('tlsClientError', () => undefined);
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', done);
  });
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => server.close(() => done()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    try {
      process.loadEnvFile();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const settings = devMailSettings(process.env);
    if (settings) {
      const { port } = await startDevMailServer({
        ...settings,
        print: (text) => console.log(text),
      });
      console.log(
        `Development mail server on localhost:${port}. Emails are printed here, never sent.`,
      );
    } else {
      console.log(
        'Development mail server not started: .env does not use the local mail settings.',
      );
    }
  } catch (error) {
    console.error(
      error.code === 'EADDRINUSE'
        ? 'Development mail server: the SMTP_PORT in .env is already in use.'
        : 'Development mail server failed to start.',
    );
    process.exitCode = 1;
  }
}
