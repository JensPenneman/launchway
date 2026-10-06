import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';
import type { AppEnv } from '../deps.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Outermost middleware: request id (`X-Request-Id`, accepted from the client when well-formed),
 * a request-scoped child logger and one access-log line per request. Query strings, headers and
 * bodies are never logged.
 */
export function requestContext(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    const log = logger.child({ requestId });
    c.set('requestId', requestId);
    c.set('logger', log);
    c.set('clientIp', null);
    c.set('principal', null);
    const started = performance.now();
    await next();
    c.header('X-Request-Id', requestId);
    const status = c.res.status;
    const entry = {
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs: Math.round(performance.now() - started),
      clientIp: c.get('clientIp'),
    };
    if (status >= 500) log.error(entry, 'request failed');
    else if (c.req.path.startsWith('/api/health/')) log.debug(entry, 'request completed');
    else log.info(entry, 'request completed');
  };
}
