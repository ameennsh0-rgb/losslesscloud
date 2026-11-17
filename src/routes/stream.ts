import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app.js';
import type { TrackRow } from '../db.js';
import { bestVariant } from '../matcher/match.js';
import { NotCachedError, TorboxError } from '../torbox/client.js';
import { MissingKeyError, PreparingError, RateLimitedError } from '../torbox/stream.js';
import { parseId } from './serialize.js';

const flag = (v: string | undefined, d: boolean) => (v === undefined ? d : !['false', '0', 'off', 'no'].includes(v.toLowerCase()));

export async function streamRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get<{ Params: { id: string }; Querystring: { torboxKey?: string; cachedOnly?: string; preferHiRes?: string } }>(
    '/stream/:id',
    async (req, reply) => {
      const rowId = parseId(req.params.id, 'trk');
      let track = rowId ? (ctx.db.prepare('SELECT * FROM tracks WHERE id = ?').get(rowId) as TrackRow | undefined) : undefined;
      if (!track) return reply.code(404).send({ error: 'track not found' });
      const preferHiRes = flag(req.query.preferHiRes, true);
      track = bestVariant(ctx.db, track, preferHiRes);
      const id = req.params.id;

      try {
        return await ctx.stream.resolve(track, {
          torboxKey: req.query.torboxKey ?? '',
          cachedOnly: flag(req.query.cachedOnly, true),
        });
      } catch (e) {
        if (e instanceof PreparingError) {
          return reply.code(503).header('Retry-After', '5').send({
            notice: { id: `prep-${id}`, title: 'Preparing Audio', message: 'Caching lossless file in cloud storage...' },
          });
        }
        if (e instanceof NotCachedError) {
          return reply.code(404).send({
            error: 'not_cached',
            notice: { id: `nocache-${id}`, title: 'Not Instantly Available', message: 'This release is not cached on TorBox. Disable "Instant Cache Only" to download it.' },
          });
        }
        if (e instanceof RateLimitedError) {
          return reply.code(429).header('Retry-After', String(e.retryAfterSec)).send({
            error: 'rate_limited',
            notice: { id: `rate-${id}`, title: 'Download Limit Reached', message: 'TorBox allows 60 uncached additions per hour. Try again later.' },
          });
        }
        if (e instanceof MissingKeyError) return reply.code(401).send({ error: 'torboxKey required' });
        if (e instanceof TorboxError) {
          req.log.warn({ status: e.status, code: e.code }, e.message);
          return reply.code(e.status === 401 || e.status === 403 ? 401 : 502).send({ error: e.message });
        }
        throw e;
      }
    },
  );
}
