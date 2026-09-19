/** Standalone migration runner: `npm run migrate`. */
import { config } from '../config/index.js';
import { createDatabase } from './db.js';
import { log } from '../logger.js';

const db = await createDatabase(config.databaseUrl);
if (!db.enabled) {
  log.error('DATABASE_URL is not set or unreachable — nothing to migrate');
  process.exit(1);
}
await db.migrate();
await db.close();
log.info('migrations applied');
