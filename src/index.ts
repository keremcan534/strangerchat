/**
 * Entry point — wires the components of §44 together:
 *
 *   frontend -> websocket -> chat server -> match engine -> redis / postgres
 *                                        \-> translation service -> Google
 *                                        \-> bot manager -> AI model
 */
import { createApp } from './app.js';
import { config } from './config/index.js';
import { log, setLogLevel } from './logger.js';

setLogLevel(config.logLevel);

const app = await createApp();
await app.listen();

log.info('strangerchat listening', {
  url: `http://${config.host}:${config.port}`,
  store: app.kv.name,
  database: app.db.enabled ? 'postgres' : 'memory',
  translationProvider: app.translation.providerName,
  botProvider: app.bot.providerName,
  botMode: config.bot.mode,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });

  const forced = setTimeout(() => process.exit(1), 5_000);
  forced.unref();
  await app.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: String(reason) });
});
