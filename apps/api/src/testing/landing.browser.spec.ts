import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

import { chromium, type Browser, type Page } from 'playwright';

import { accessible } from './browser-identity';

// These names are used only inside callbacks serialized into Chromium. Keep DOM lib globals
// out of the Node test project, as the other browser specs do.
declare const document: {
  documentElement: {
    lang: string;
    scrollWidth: number;
    clientWidth: number;
    dataset: Record<string, string | undefined>;
  };
  activeElement: { classList: { contains: (name: string) => boolean } } | null;
};

/** apps/landing, served as Vercel serves it: its headers (CSP included) and clean URLs. */
const ROOT = join(__dirname, '..', '..', '..', 'landing');
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};
const WIDTHS = [320, 375, 768, 1024, 1440];
const PAGES = [
  { path: '/', lang: 'fr', menu: 'Menu', close: 'Fermer' },
  { path: '/en', lang: 'en', menu: 'Menu', close: 'Close' },
] as const;

/** Runs in the page: keeps every CSP violation in `window.__csp`. */
const RECORD_VIOLATIONS = `document.addEventListener('securitypolicyviolation', (event) => {
  (window.__csp = window.__csp || []).push(event.violatedDirective + ' ' + event.blockedURI);
});`;

async function headers(): Promise<Record<string, string>> {
  const config = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  const all = config.headers.find((rule) => rule.source === '/(.*)');
  if (!all) throw new Error('vercel.json has no header rule for every path');
  return Object.fromEntries(all.headers.map(({ key, value }) => [key, value]));
}

async function serve(): Promise<{ server: Server; origin: string }> {
  const fixed = await headers();
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://landing').pathname);
    const clean = path.endsWith('/')
      ? `${path}index.html`
      : extname(path)
        ? path
        : `${path}/index.html`;
    const file = normalize(join(ROOT, clean));
    if (!file.startsWith(ROOT + sep)) {
      response.writeHead(400).end();
      return;
    }
    readFile(file)
      .then((body) => {
        response.writeHead(200, {
          ...fixed,
          'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        });
        response.end(body);
      })
      .catch(() => response.writeHead(404, fixed).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
}

/** Issue #209: the landing page under its production CSP, in both languages. */
describe('landing page in Chromium', () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    ({ server, origin } = await serve());
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  /** A page whose third-party requests (fonts, icons, logos) are answered locally. */
  async function open(path: string, width = 1440): Promise<{ page: Page; problems: string[] }> {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const problems: string[] = [];
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      // Fonts and icon stylesheets come as empty CSS, logos as an empty SVG: hermetic and quiet.
      if (route.request().resourceType() === 'stylesheet')
        return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      });
    });
    await page.addInitScript(RECORD_VIOLATIONS);
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));
    await page.goto(origin + path, { waitUntil: 'networkidle' });
    return { page, problems };
  }
  const violations = (page: Page): Promise<string[]> =>
    page.evaluate<string[]>('window.__csp || []');

  for (const landing of PAGES) {
    it(`loads ${landing.path} without error, CSP violation or accessibility issue`, async () => {
      const { page, problems } = await open(landing.path);
      expect(await page.evaluate(() => document.documentElement.lang)).toBe(landing.lang);
      // Before axe: it fetches stylesheets itself, which the page's CSP rightly refuses.
      expect(await violations(page)).toEqual([]);
      expect(problems).toEqual([]);
      await accessible(page);
      await page.context().close();
    });

    it(`never scrolls sideways on ${landing.path}, from 320 to 1440 px`, async () => {
      const { page } = await open(landing.path, 320);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(100);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${landing.path} at ${String(width)} px`).toBeLessThanOrEqual(0);
      }
      await page.context().close();
    });

    it(`opens and closes the menu, switches the theme and explains a shipkeep.yml line on ${landing.path}`, async () => {
      const { page, problems } = await open(landing.path, 375);
      const burger = page.locator('.burger');
      await burger.click();
      await expect.poll(() => burger.getAttribute('aria-expanded')).toBe('true');
      expect(await page.locator('#sk-menu').isVisible()).toBe(true);
      await page.keyboard.press('Escape');
      expect(await page.locator('#sk-menu').isHidden()).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.classList.contains('burger'))).toBe(
        true,
      );

      const theme = page.locator('header [data-theme-toggle]').first();
      await theme.click();
      expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe('light');
      await theme.click();
      expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBeUndefined();

      const line = page.locator('#opensource .yl').nth(1);
      await line.click();
      expect(await line.getAttribute('class')).toContain('on');
      expect(await page.locator('#opensource .yt').textContent()).toBe(
        await line.getAttribute('data-title'),
      );
      expect(await violations(page)).toEqual([]);
      expect(problems).toEqual([]);
      await page.context().close();
    });
  }
});
