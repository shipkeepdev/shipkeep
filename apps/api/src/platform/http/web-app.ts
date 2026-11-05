import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { open, opendir, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export const WEB_NONCE_PLACEHOLDER = '__SHIPKEEP_CSP_NONCE__';
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};
type Asset = { body: Buffer; type: string; etag: string; immutable: boolean };

/** Snapshot the trusted build before listening: requests never resolve user paths on disk. */
export async function installWebApp(app: INestApplication, directory: string): Promise<void> {
  let assets: Map<string, Asset>;
  let index: string;
  try {
    const root = await realpath(directory);
    assets = new Map();
    let total = 0;
    let entries = 0;
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (depth > 16) throw new Error('Invalid build.');
      for await (const entry of await opendir(join(root, relative))) {
        if (++entries > 1024 || entry.isSymbolicLink()) throw new Error('Invalid build.');
        if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(entry.name)) continue;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(name, depth + 1);
          continue;
        }
        const type = name === 'index.html' ? 'text/html' : TYPES[extname(name)];
        if (!type || !entry.isFile()) continue;
        const file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        let body: Buffer;
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > MAX_FILE || total + info.size > MAX_TOTAL)
            throw new Error('Invalid build.');
          // One extra byte detects growth without reading an unbounded file into memory.
          const buffer = Buffer.alloc(info.size + 1);
          let size = 0;
          while (size < buffer.length) {
            const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
            if (!bytesRead) break;
            size += bytesRead;
          }
          if (size !== info.size) throw new Error('Invalid build.');
          body = buffer.subarray(0, size);
          total += size;
        } finally {
          await file.close();
        }
        assets.set(`/${name}`, {
          body,
          type,
          etag: `"${createHash('sha256').update(body).digest('hex')}"`,
          immutable: /^(?:main|chunk|styles|polyfills)-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(name),
        });
      }
    };
    await walk('', 0);
    index = assets.get('/index.html')?.body.toString('utf8') ?? '';
    if (
      index.split(WEB_NONCE_PLACEHOLDER).length !== 2 ||
      !index.includes(`ngCspNonce="${WEB_NONCE_PLACEHOLDER}"`)
    )
      throw new Error('Invalid build.');
    assets.delete('/index.html');
  } catch {
    throw new Error('Built web assets are missing or invalid.');
  }

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      next();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(request.path);
    } catch {
      next();
      return;
    }
    if (
      !path.startsWith('/') ||
      path.includes('\\') ||
      path.includes('%') ||
      /\p{Cc}/u.test(path) ||
      path.split('/').some((segment) => segment.startsWith('.')) ||
      /^\/api(?:\/|$)/i.test(path)
    ) {
      next();
      return;
    }
    const asset = assets.get(path);
    if (asset) {
      response.setHeader(
        'Cache-Control',
        asset.immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      );
      response.setHeader('ETag', asset.etag);
      response.type(asset.type).send(asset.body);
      return;
    }
    if (path.includes('.') || !request.accepts('html')) {
      next();
      return;
    }
    const nonce = randomBytes(24).toString('base64url');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        "script-src 'self'",
        `style-src 'self' 'nonce-${nonce}'`,
        "style-src-attr 'none'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        'trusted-types angular angular#bundler',
        "require-trusted-types-for 'script'",
      ].join('; '),
    );
    response.type('html').send(index.replace(WEB_NONCE_PLACEHOLDER, nonce));
  });
}
