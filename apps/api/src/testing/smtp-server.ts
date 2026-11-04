import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type TLSSocket } from 'node:tls';

import { localhostTls } from './localhost-tls';

export interface SmtpFixture {
  readonly port: number;
  readonly caFile: string;
  readonly commands: string[];
  readonly messages: string[];
  close: () => Promise<void>;
}

/** Loopback-only TLS SMTP fixture. Keys exist only in memory; no external mail is sent. */
export async function smtpServer(): Promise<SmtpFixture> {
  const tls = await localhostTls();
  const directory = await mkdtemp(join(tmpdir(), 'shipkeep-smtp-test-'));
  const caFile = join(directory, 'ca.crt');
  await writeFile(caFile, tls.cert);
  const commands: string[] = [];
  const messages: string[] = [];
  const sockets = new Set<TLSSocket>();
  const server = createServer(tls, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {
      /* Peer verification failures are expected in negative tests. */
    });
    socket.setEncoding('utf8');
    socket.write('220 localhost test SMTP\r\n');
    let pending = '';
    let data: string[] | undefined;
    socket.on('data', (chunk: string) => {
      pending += chunk;
      if (pending.length > 65536) {
        socket.destroy();
        return;
      }
      let boundary: number;
      while ((boundary = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (data) {
          if (line === '.') {
            messages.push(data.join('\n'));
            data = undefined;
            socket.write('250 accepted\r\n');
          } else data.push(line);
          continue;
        }
        commands.push(line);
        if (/^EHLO /i.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (/^(AUTH |MAIL FROM:|RCPT TO:)/i.test(line))
          socket.write(line.startsWith('AUTH') ? '235 authenticated\r\n' : '250 ok\r\n');
        else if (line.toUpperCase() === 'DATA') {
          data = [];
          socket.write('354 send data\r\n');
        } else if (line.toUpperCase() === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  server.on('tlsClientError', () => {
    /* Negative tests intentionally reject the certificate. */
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('SMTP fixture did not bind');
    return {
      port: address.port,
      caFile,
      commands,
      messages,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        );
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
