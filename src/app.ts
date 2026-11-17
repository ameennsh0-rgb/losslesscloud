import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { albumRoutes } from './routes/album.js';
import { manifestRoutes } from './routes/manifest.js';
import { resolveRoutes } from './routes/resolve.js';
import { searchRoutes } from './routes/search.js';
import { streamRoutes } from './routes/stream.js';
import { StreamService } from './torbox/stream.js';

export interface Ctx { db: DB; cfg: Config; stream: StreamService }

export async function buildApp(db: DB, cfg: Config, opts: { logger?: boolean } = {}) {
  // torboxKey travels in the query string: redact it from access logs
  const redact = (u?: string) => u?.replace(/([?&](?:torboxKey|token|apikey)=)[^&]*/gi, '$1***');
  const app = Fastify({
    trustProxy: true,
    logger: opts.logger
      ? { serializers: { req: (r) => ({ method: r.method, url: redact(r.url), remoteAddress: r.ip }) } }
      : false,
  });
  await app.register(cors, { origin: '*', exposedHeaders: ['Retry-After'] });

  const ctx: Ctx = { db, cfg, stream: new StreamService(db, cfg) };
  await manifestRoutes(app);
  await searchRoutes(app, ctx);
  await albumRoutes(app, ctx);
  await resolveRoutes(app, ctx);
  await streamRoutes(app, ctx);
  return { app, ctx };
}
