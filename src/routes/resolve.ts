import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app.js';
import { resolveTrack } from '../matcher/match.js';
import { trackJson } from './serialize.js';

export async function resolveRoutes(app: FastifyInstance, ctx: Ctx) {
  const handle = (q: { isrc?: string; title?: string; artist?: string; durationMs?: string; preferHiRes?: string }) => {
    const durationMs = q.durationMs ? Number(q.durationMs) : undefined;
    const t = resolveTrack(ctx.db, ctx.cfg, { isrc: q.isrc, title: q.title, artist: q.artist, durationMs }, q.preferHiRes !== 'false');
    return t ? { item: trackJson(t) } : null;
  };

  app.get<{ Querystring: { isrc?: string } }>('/resolve-isrc', async (req, reply) => {
    if (!req.query.isrc) return reply.code(400).send({ error: 'missing isrc' });
    return handle({ isrc: req.query.isrc }) ?? reply.code(404).send({ item: null });
  });

  app.get<{ Querystring: { isrc?: string; title?: string; artist?: string; durationMs?: string; preferHiRes?: string } }>(
    '/resolve',
    async (req, reply) => {
      const q = req.query;
      if (!q.isrc && !(q.title && q.artist)) return reply.code(400).send({ error: 'need isrc or title+artist' });
      return handle(q) ?? reply.code(404).send({ item: null });
    },
  );
}
