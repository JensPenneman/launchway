// Drizzle schema of the whole database. Each module owns its tables in
// src/modules/<module>/schema.ts; this file only re-exports them (drizzle-kit and the
// relational query API read from here). Keep the list alphabetical.
export * from '../modules/apps/schema.js';
export * from '../modules/audit/schema.js';
export * from '../modules/auth/schema.js';
export * from '../modules/deployments/schema.js';
export * from '../modules/dns/schema.js';
export * from '../modules/domains/schema.js';
export * from '../modules/github/schema.js';
export * from '../modules/invitations/schema.js';
export * from '../modules/nodes/schema.js';
export * from '../modules/routes/schema.js';
export * from '../modules/settings/schema.js';
export * from '../modules/tokens/schema.js';
export * from '../modules/users/schema.js';
