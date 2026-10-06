import { type Hook, OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv, Deps } from './deps.js';
import { authenticate } from './lib/auth-context.js';
import { clientIp, createTrustedProxyList } from './lib/client-ip.js';
import { openApiObject, registerSecuritySchemes } from './lib/openapi.js';
import {
  notFound,
  ProblemError,
  problemResponse,
  toProblem,
  toValidationIssues,
} from './lib/problem.js';
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
  app.use('/api/*', authenticate(deps.auth));

  const api = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
  const v1 = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
  registerModules({ api, v1 }, deps);
  api.route('/v1', v1);
  app.route('/api', api);

  registerSecuritySchemes(app);
  app.doc31('/api/openapi.json', openApiObject(deps.version));
  app.get('/api/docs', Scalar({ url: '/api/openapi.json', pageTitle: 'Slipway API' }));

  app.notFound((c) => {
    throw notFound(`No route for ${c.req.method} ${c.req.path}`);
  });
  app.onError(onError);

  registerWebUi(app, deps.config.webRoot, deps.logger);
  return app;
}
