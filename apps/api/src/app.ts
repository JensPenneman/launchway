import { type Hook, OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv, Deps } from './deps.js';
import { authenticate } from './lib/auth-context.js';
import { clientIp, createTrustedProxyList } from './lib/client-ip.js';
import { createPlatformOriginResolver, csrfProtection } from './lib/csrf.js';
import { openApiObject, registerSecuritySchemes } from './lib/openapi.js';
import {
  notFound,
  ProblemError,
  problemResponse,
  toProblem,
  toValidationIssues,
} from './lib/problem.js';
import { rateLimit } from './lib/rate-limit.js';
import { requestContext } from './lib/request-context.js';
import { registerWebUi } from './lib/static.js';
import { registerModules } from './modules/index.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Turns request validation failures of @hono/zod-openapi routes into 400 validation-failed. */
const validationHook: Hook<unknown, AppEnv, string, unknown> = (result) => {
  if (!result.success) {
    const prefix = result.target === 'json' || result.target === 'form' ? 'body' : result.target;
    throw new ProblemError('validation-failed', {
      errors: toValidationIssues(result.error, prefix),
    });
  }
};

function onError(error: Error, c: Context<AppEnv>): Response {
  const { problem, headers } = toProblem(error);
  const logger = c.get('logger');
  if (problem.status >= 500) logger?.error({ err: error }, 'unhandled error');
  else logger?.debug({ type: problem.type }, 'request rejected');
  return problemResponse(
    c,
    { ...problem, instance: c.req.path, requestId: c.get('requestId') },
    headers,
  );
}

/**
 * Builds the HTTP application: global middleware, the module routers under /api and /api/v1,
 * the OpenAPI document and docs, and the web UI. Creating the app opens no connections.
 */
export function createApp(deps: Deps): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

  app.use('*', requestContext(deps.logger));
  app.use('*', clientIp(createTrustedProxyList(deps.config.trustedProxies)));
  app.use('*', secureHeaders());
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new ProblemError('payload-too-large');
      },
    }),
  );
  app.use('/api/*', rateLimit());
  app.use('/api/*', authenticate(deps.auth));
  app.use('/api/*', csrfProtection(createPlatformOriginResolver(deps)));

  const api = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
  const v1 = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
  registerModules({ api, v1 }, deps);
  api.route('/v1', v1);
  app.route('/api', api);

  registerSecuritySchemes(app);
  app.doc31('/api/openapi.json', openApiObject(deps.version));
  app.get('/api/docs', scalarReference());

  app.notFound((c) => {
    throw notFound(`No route for ${c.req.method} ${c.req.path}`);
  });
  app.onError(onError);

  registerWebUi(app, deps.config.webRoot, deps.logger);
  return app;
}

/**
 * Scalar's bundle runs on the platform origin, next to the session cookie: load an exact version
 * and let the browser verify it (SRI) instead of whatever the CDN serves as latest. Update both
 * together: `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
 */
const SCALAR_BUNDLE =
  'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.73.0/dist/browser/standalone.js';
const SCALAR_INTEGRITY = 'sha384-OKyMdsDX84ypSZEhVun8YElXk5c2GQaH3EXPOc6ItmVcLDUAvKHYwvDLvAgsqVtB';

function scalarReference(): MiddlewareHandler {
  const render = Scalar({
    url: '/api/openapi.json',
    pageTitle: 'Launchway API',
    cdn: SCALAR_BUNDLE,
  });
  return async (c, next) => {
    const res = await render(c, next);
    if (!res) return res;
    const html = (await res.text()).replace(
      `<script src="${SCALAR_BUNDLE}">`,
      `<script src="${SCALAR_BUNDLE}" integrity="${SCALAR_INTEGRITY}" crossorigin="anonymous">`,
    );
    if (!html.includes(SCALAR_INTEGRITY)) throw new Error('Scalar page without the pinned bundle');
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    return new Response(html, { status: res.status, headers });
  };
}
