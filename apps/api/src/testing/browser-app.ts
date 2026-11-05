import { resolve } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { chromium, type BrowserContext } from 'playwright';

import { installWebApp } from '../platform/http/web-app';

import { integrationApp } from './integration-app';
import { localhostTls } from './localhost-tls';
import { smtpServer } from './smtp-server';

/** Real production assets, HTTPS, PostgreSQL and TLS SMTP, all disposable and loopback-only. */
export async function browserApp(): Promise<{
  context: BrowserContext;
  newContext: () => Promise<BrowserContext>;
  origin: string;
  messages: string[];
  close: () => Promise<void>;
}> {
  const restore: Record<string, string | undefined> = {};
  const cleanups: (() => Promise<unknown>)[] = [];
  const close = async () => {
    try {
      // Reverse acquisition order: the browser stops before its services.
      let failed = false;
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          await cleanup();
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error('Browser fixture cleanup failed.');
    } finally {
      for (const [key, value] of Object.entries(restore)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  };
  try {
    const smtp = await smtpServer();
    cleanups.push(smtp.close);
    const environment = {
      NODE_ENV: 'test',
      API_PUBLIC_URL: 'https://localhost',
      TRUST_PROXY: 'none',
      OPENAPI_UI: 'false',
      SMTP_HOST: 'localhost',
      SMTP_PORT: String(smtp.port),
      SMTP_FROM: 'notifications@example.com',
      SMTP_USER: 'fixture-user',
      SMTP_PASSWORD: 'fixture-password',
      SMTP_CA_FILE: smtp.caFile,
    };
    for (const [key, value] of Object.entries(environment)) {
      restore[key] = process.env[key];
      process.env[key] = value;
    }
    const backend = await integrationApp([], {
      // Never reset an inherited developer DATABASE_URL, including one loaded by Nx.
      isolatedDatabase: true,
      httpsOptions: await localhostTls(),
      beforeInit: (app) =>
        installWebApp(app, resolve(__dirname, '../../../../dist/apps/web/browser')),
    });
    cleanups.push(backend.close);
    await backend.app.listen(0, '127.0.0.1');
    const origin = (await backend.app.getUrl()).replace('127.0.0.1', 'localhost');
    // Bind the random test port before the first request, preserving exact-Origin validation.
    backend.app.get(ConfigService).set('API_PUBLIC_URL', origin);
    const browser = await chromium.launch();
    cleanups.push(() => browser.close());
    const newContext = async (): Promise<BrowserContext> => {
      const context = await browser.newContext({
        baseURL: origin,
        // Only this isolated self-signed HTTPS fixture; production TLS validation is unchanged.
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 1000 },
      });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      context.setDefaultTimeout(15_000);
      return context;
    };
    return { context: await newContext(), newContext, origin, messages: smtp.messages, close };
  } catch (error: unknown) {
    await close();
    throw error;
  }
}
