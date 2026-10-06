// Applies pending migrations (the API also does this at start). Usage: pnpm db:migrate
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';

const config = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel, name: 'slipway-migrate' });
const pool = createPool(config.databaseUrl, logger);
try {
  await runMigrations(pool, logger);
} finally {
  await pool.end();
}
