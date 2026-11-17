import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app.js';
import type { ReleaseRow, TrackRow } from '../db.js';
import { albumJson, parseId, trackJson } from './serialize.js';

export async function albumRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get<{ Params: { id: string } }>('/album/:id', async (req, reply) => {
    const id = parseId(req.params.id, 'alb');
    const r = id ? (ctx.db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as ReleaseRow | undefined) : undefined;
    if (!r) return reply.code(404).send({ error: 'album not found' });
    const tracks = ctx.db.prepare('SELECT * FROM tracks WHERE release_id = ? ORDER BY disc, track_no, file_path').all(r.id) as TrackRow[];
    return { ...albumJson(r, tracks.length), tracks: tracks.map(trackJson) };
  });
}
