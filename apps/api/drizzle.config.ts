import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` diffs src/db/schema.ts against drizzle/meta and writes the next SQL migration.
// Migrations are applied by the API at start (src/db/migrate.ts), not by drizzle-kit.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://slipway:slipway@localhost:5432/slipway',
  },
  strict: true,
  verbose: true,
});
