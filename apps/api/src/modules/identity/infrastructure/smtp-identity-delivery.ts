import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SMTPClient } from 'emailjs';

import { AppConfig } from '../../../platform/config/app-config';
import type { IdentityMailer } from '../application/identity-ports';
import { normalizeEmail, TOKEN_PATTERN } from '../domain/identity-policy';

import type { IdentityDelivery } from './private-identity-mail';

/** Implicit TLS only: certificate chain and hostname verification cannot be disabled. */
@Injectable()
export class SmtpIdentityDelivery implements IdentityDelivery {
  constructor(private readonly config: AppConfig) {}

  async deliver(input: Parameters<IdentityMailer['send']>[0]): Promise<void> {
    let client: SMTPClient | undefined;
    let deadline: NodeJS.Timeout | undefined;
    try {
      const host = this.config.get('SMTP_HOST');
      const from = this.config.get('SMTP_FROM');
      if (!host || !from) throw new Error('SMTP is not configured');
      const recipient = normalizeEmail(input.email);
      if (!TOKEN_PATTERN.test(input.token.expose()) || !['verify', 'reset'].includes(input.purpose))
        throw new Error('invalid mail input');
      if (input.expiresAt.getTime() <= Date.now()) return;
      let ca: Buffer | undefined;
      const caFile = this.config.get('SMTP_CA_FILE');
      if (caFile) {
        const info = await stat(caFile);
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error('invalid CA bundle');
        ca = await readFile(caFile);
      }
      client = new SMTPClient({
        host,
        port: this.config.get('SMTP_PORT'),
        timeout: 10000,
        ssl: {
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          ...(isIP(host) ? {} : { servername: host }),
          ...(ca ? { ca } : {}),
        },
        tls: false,
        user: this.config.get('SMTP_USER'),
        password: this.config.get('SMTP_PASSWORD')?.expose(),
        authentication: ['PLAIN', 'LOGIN'],
        logger: () => {
          /* SMTP commands may contain credentials. */
        },
      });
      const url = new URL(
        input.purpose === 'verify' ? '/verify-email' : '/reset-password',
        this.config.get('API_PUBLIC_URL'),
      );
      const operation = input.purpose === 'verify' ? 'Verify your email' : 'Reset your password';
      const digest = createHash('sha256').update(input.token.expose()).digest('hex');
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          reject(new Error('SMTP deadline exceeded'));
        }, 20000);
      });
      await Promise.race([
        client.sendAsync({
          from: normalizeEmail(from),
          to: recipient,
          subject: `Shipkeep: ${operation.toLowerCase()}`,
          'message-id': `<${digest}@${url.hostname}>`,
          text: `${operation} in Shipkeep.\n\nOpen ${url.href} and paste this code:\n\n${input.token.expose()}\n\nThis code expires at ${input.expiresAt.toISOString()}.\nIf you did not request this, you can ignore this email.`,
        }),
        timeout,
      ]);
    } catch {
      throw new ServiceUnavailableException('Identity email delivery failed.');
    } finally {
      if (deadline) clearTimeout(deadline);
      client?.smtp.close(true);
    }
  }
}
