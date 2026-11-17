import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app.js';
import type { ReleaseRow, TrackRow } from '../db.js';
import { ingestItems } from '../indexer/ingest.js';
import { searchTorznab } from '../indexer/torznab.js';
import { normalize } from '../matcher/normalize.js';
import { albumJson, trackJson } from './serialize.js';

/** Build an FTS5 MATCH expression: every token must match (prefix on the last one). */
export function ftsQuery(q: string): string | null {
  const toks = normalize(q, { keepEdition: true }).split(' ').filter(Boolean).slice(0, 8);
  if (!toks.length) return null;
  return toks.map((t, i) => `"${t.replace(/"/g, '')}"${i === toks.length - 1 ? '*' : ''}`).join(' ');
}

export function searchLocal(ctx: Ctx, q: string, limit = 40) {
  const match = ftsQuery(q);
  if (!match) return { tracks: [] as TrackRow[], albums: [] as { r: ReleaseRow; n: number }[] };
  const tracks = ctx.db
    .prepare(`SELECT t.* FROM tracks_fts f JOIN tracks t ON t.id = f.rowid JOIN releases r ON r.id = t.release_id
              WHERE tracks_fts MATCH ? ORDER BY bm25(tracks_fts), r.seeders DESC LIMIT ?`)
    .all(match, limit) as TrackRow[];
  // albums: releases whose own text matches, plus the releases of matching tracks
  const albums = ctx.db
    .prepare(`SELECT r.*, (SELECT COUNT(*) FROM tracks t WHERE t.release_id = r.id) AS n FROM releases r
              WHERE r.files_indexed = 1 AND (r.id IN (SELECT rowid FROM releases_fts WHERE releases_fts MATCH @m ORDER BY bm25(releases_fts) LIMIT @l)
                 OR r.id IN (SELECT release_id FROM tracks WHERE id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH @m LIMIT @l)))
              ORDER BY r.seeders DESC LIMIT @l`)
    .all({ m: match, l: Math.ceil(limit / 2) }) as (ReleaseRow & { n: number })[];
  return { tracks, albums: albums.map((r) => ({ r, n: r.n })) };
}

export async function searchRoutes(app: FastifyInstance, ctx: Ctx) {
  const inflight = new Map<string, Promise<void>>();

  app.get<{ Querystring: { q?: string } }>('/search', async (req, reply) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return reply.code(400).send({ error: 'missing q' });
    const key = normalize(q, { keepEdition: true });

    let local = searchLocal(ctx, q);
    const log = ctx.db.prepare('SELECT searched_at FROM search_log WHERE query = ?').get(key) as { searched_at: number } | undefined;
    const stale = !log || Date.now() - log.searched_at > ctx.cfg.searchTtlMs;

    if ((stale || local.tracks.length === 0) && ctx.cfg.torznab.endpoints.length) {
      // de-dupe concurrent identical lookups
      if (!inflight.has(key)) {
        const job = (async () => {
          const items = await searchTorznab(ctx.cfg, q);
          const r = await ingestItems(ctx.db, ctx.cfg, items, 'torznab');
          ctx.db.prepare('INSERT OR REPLACE INTO search_log (query, searched_at, result_count) VALUES (?,?,?)').run(key, Date.now(), r.tracks);
        })().finally(() => inflight.delete(key));
        inflight.set(key, job);
      }
      try {
        await Promise.race([
          inflight.get(key)!,
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ctx.cfg.onDemandTimeoutMs + 2000).unref()),
        ]);
        local = searchLocal(ctx, q);
      } catch (e) {
        req.log.warn({ err: (e as Error).message }, 'on-demand lookup failed; serving local index');
      }
    }
    return { tracks: local.tracks.map(trackJson), albums: local.albums.map(({ r, n }) => albumJson(r, n)) };
  });
}
