import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { startFeedPoller } from './indexer/feeds.js';
import { openDb } from './migrate.js';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);

const { app, ctx } = await buildApp(db, cfg, { logger: true });
const stopFeeds = startFeedPoller(db, cfg);
const purge = setInterval(() => ctx.stream.purgeExpired(), 3600_000);
purge.unref();

const shutdown = async () => { stopFeeds(); await app.close(); db.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: cfg.port, host: cfg.host });
