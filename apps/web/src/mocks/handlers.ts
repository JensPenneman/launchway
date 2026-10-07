import { appHandlers } from './handlers/apps';
import { authHandlers } from './handlers/auth';
import { dnsHandlers } from './handlers/dns';
import { platformHandlers } from './handlers/platform';
import { previewHandlers } from './handlers/previews';

/** Every endpoint of the Launchway API, backed by the in-memory mock database. */
export const handlers = [
  ...authHandlers,
  ...appHandlers,
  ...previewHandlers,
  ...dnsHandlers,
  ...platformHandlers,
];
