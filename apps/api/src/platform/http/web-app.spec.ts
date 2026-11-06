import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import helmet from 'helmet';
import request from 'supertest';

import { installWebApp, WEB_NONCE_PLACEHOLDER } from './web-app';

describe('production browser serving', () => {
  let app: INestApplication;
  let directory: string;
  const http = () => request(app.getHttpServer() as Server);
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'shipkeep-web-test-'));
    await writeFile(
      join(directory, 'index.html'),
      `<html><body><sk-root ngCspNonce="${WEB_NONCE_PLACEHOLDER}"></sk-root><script src="main-ABCDEFGH.js" type="module"></script></body></html>`,
    );
    await writeFile(join(directory, 'main-ABCDEFGH.js'), 'window.fixture = true;');
    await writeFile(join(directory, 'favicon.ico'), 'public fixture icon');
    const module = await Test.createTestingModule({}).compile();
    app = module.createNestApplication({ logger: false });
    app.use(helmet());
    app.getHttpAdapter().get('/api/v1/health', (_request: Request, response: Response) => {
      response.json({ status: 'ok' });
    });
  });
  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function start(): Promise<void> {
    await installWebApp(app, directory);
    await app.init();
  }

  it('serves deep links with fresh nonces, strict CSP and no page caching', async () => {
    await start();
    const first = await http().get('/auth/login').set('Accept', 'text/html').expect(200);
    const second = await http().get('/account/security').set('Accept', 'text/html').expect(200);
    const nonce = /ngCspNonce="([A-Za-z0-9_-]+)"/i.exec(first.text)?.at(1);
    expect(nonce).toHaveLength(32);
    expect(first.headers['content-security-policy']).toContain(`'nonce-${nonce ?? ''}'`);
    expect(first.headers['content-security-policy']).toContain(
      "require-trusted-types-for 'script'",
    );
    expect(first.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(second.text).not.toContain(nonce);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    const head = await http().head('/auth/login').expect(200);
    expect(head.text).toBeUndefined();
  });
  it('serves only a frozen public asset snapshot and caches only hashed bundles immutably', async () => {
    await start();
    await writeFile(join(directory, 'main-ABCDEFGH.js'), 'changed after startup');
    const asset = await http().get('/main-ABCDEFGH.js').expect(200);
    expect(asset.text).toBe('window.fixture = true;');
    expect(asset.headers['content-type']).toContain('javascript');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const icon = await http().get('/favicon.ico').expect(200);
    expect(icon.headers['cache-control']).toBe('public, max-age=300');
  });
  it('serves only the named installer artifacts and keeps their manifest uncached', async () => {
    await mkdir(join(directory, 'install'));
    const binary = `agent-${'a'.repeat(64)}.bin`;
    for (const name of [binary, 'manifest.json', 'private.json', 'arbitrary.sh'])
      await writeFile(join(directory, 'install', name), '{}');
    await start();
    await http()
      .get(`/install/${binary}`)
      .expect(200)
      .expect('Content-Type', 'application/octet-stream')
      .expect('Cache-Control', 'public, max-age=31536000, immutable');
    await http().get('/install/manifest.json').expect(200).expect('Cache-Control', 'no-store');
    for (const name of ['private.json', 'arbitrary.sh'])
      await http().get(`/install/${name}`).expect(404);
  });
  it('replaces every nonce in normalized Angular build output', async () => {
    await writeFile(
      join(directory, 'index.html'),
      `<sk-root ngcspnonce="${WEB_NONCE_PLACEHOLDER}"></sk-root><script src="main-ABCDEFGH.js" nonce="${WEB_NONCE_PLACEHOLDER}"></script><link rel="stylesheet" href="styles.css" nonce="${WEB_NONCE_PLACEHOLDER}">`,
    );
    await start();
    const response = await http().get('/auth/login').expect(200);
    const nonces = [...response.text.matchAll(/nonce="([A-Za-z0-9_-]+)"/g)].map(
      (match) => match[1],
    );
    expect(nonces).toHaveLength(3);
    expect(new Set(nonces).size).toBe(1);
    expect(nonces[0]).toHaveLength(32);
    expect(response.text).not.toContain(WEB_NONCE_PLACEHOLDER);
  });
  it('keeps API paths and non-navigation requests out of the SPA fallback', async () => {
    await mkdir(join(directory, 'api'), { recursive: true });
    await writeFile(join(directory, 'api/private.js'), 'must not be served');
    await start();
    expect((await http().get('/api/v1/health').expect(200)).body).toEqual({ status: 'ok' });
    for (const path of ['/api/private.js', '/api/missing', '/API/missing', '/missing.js'])
      await http().get(path).set('Accept', 'text/html').expect(404);
    await http().post('/auth/login').expect(404);
    await http().get('/auth/login').set('Accept', 'application/json').expect(404);
  });
  it('does not expose dotfiles, maps, metadata or traversal targets', async () => {
    for (const name of ['.env', 'main.js.map', 'package.json', 'private.key'])
      await writeFile(join(directory, name), 'private fixture');
    await start();
    for (const path of [
      '/.env',
      '/main.js.map',
      '/package.json',
      '/private.key',
      '/%2e%2e/private.key',
      '/%2eenv',
      '/%252eenv',
      '/%00',
      '/%ZZ',
    ]) {
      const response = await http().get(path).set('Accept', 'text/html').expect(404);
      expect(response.text).not.toContain('private fixture');
    }
  });
  it('rejects symlinks, oversize assets and missing nonce markers without path diagnostics', async () => {
    await symlink(join(directory, 'index.html'), join(directory, 'linked.js'));
    await expect(installWebApp(app, directory)).rejects.toThrow(
      'Built web assets are missing or invalid.',
    );
    await rm(join(directory, 'linked.js'));
    await writeFile(join(directory, 'oversize.js'), Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(installWebApp(app, directory)).rejects.toThrow(
      'Built web assets are missing or invalid.',
    );
    await rm(join(directory, 'oversize.js'));
    await writeFile(join(directory, 'index.html'), '<html>missing nonce</html>');
    await expect(installWebApp(app, directory)).rejects.toThrow(
      'Built web assets are missing or invalid.',
    );
  });
});
