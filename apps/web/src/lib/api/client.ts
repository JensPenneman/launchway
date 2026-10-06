import createClient from 'openapi-fetch';
import type { paths } from './schema.gen';

/**
 * Typed client for the Slipway API, generated from its OpenAPI document (`pnpm openapi:generate`).
 * Same origin as the UI, so the session cookie is sent automatically.
 */
export const api = createClient<paths>();
