import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import type { Logger } from 'pino';
import type { AppEnv } from '../deps.js';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  // The GitHub App manifest flow posts a form to github.com.
  "form-action 'self' https://github.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

/**
 * Serves the built web UI from `root` with an SPA fallback to index.html for non-API paths.
 * Hashed assets are cached for a year; index.html is always revalidated. Returns false (and
 * serves only the API) when the directory has no index.html, e.g. during API-only development.
 */
export function registerWebUi(app: Hono<AppEnv>, root: string, logger: Logger): boolean {
  const indexFile = join(root, 'index.html');
  if (!existsSync(indexFile)) {
    logger.info({ root }, 'web UI not found; serving the API only');
    return false;
  }
  const indexHtml = readFileSync(indexFile, 'utf8');
  const assets = serveStatic<AppEnv>({ root });

  app.use('*', async (c, next) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return next();
    if (c.req.path.startsWith('/assets/')) {
      // serveStatic returns the response instead of finalizing the context, so it must be
      // returned. A missing hashed asset is a 404, never the index.html fallback.
      const response = await assets(c, async () => {});
      if (!response) return c.notFound();
      if (response.status === 200) {
        response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      }
      return response;
    }
    if (c.req.path !== '/' && c.req.path !== '/index.html') return assets(c, next);
    return next();
  });

  app.get('*', (c) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return c.notFound();
    c.header('Cache-Control', 'no-cache');
    c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    return c.html(indexHtml);
  });
  return true;
}
