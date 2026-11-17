import type { Config } from '../config.js';
import type { DB, TrackRow } from '../db.js';
import { normalize, normalizeIsrc, primaryArtist } from './normalize.js';

export interface ResolveQuery { isrc?: string; title?: string; artist?: string; durationMs?: number }

const quality = (t: Pick<TrackRow, 'bit_depth' | 'sample_rate'>) => (t.bit_depth ?? 16) * 1e6 + (t.sample_rate ?? 44100);

/** Order candidates: preferHiRes → highest bit-depth/sample-rate first, else the smallest (16/44.1) first. */
export function rankVariants<T extends Pick<TrackRow, 'bit_depth' | 'sample_rate'> & { seeders?: number | null }>(rows: T[], preferHiRes: boolean): T[] {
  return [...rows].sort((a, b) => {
    const q = preferHiRes ? quality(b) - quality(a) : quality(a) - quality(b);
    return q || (b.seeders ?? 0) - (a.seeders ?? 0);
  });
}

type Cand = TrackRow & { seeders: number | null };
const SELECT = `SELECT t.*, r.seeders AS seeders FROM tracks t JOIN releases r ON r.id = t.release_id`;

/**
 * Strict matching:
 *  1. exact ISRC
 *  2. normalized artist + title AND duration within ±tolerance (unknown duration ⇒ no match unless explicitly allowed)
 * Returns null when there is no high-confidence match.
 */
export function resolveTrack(db: DB, cfg: Config, q: ResolveQuery, preferHiRes = true): TrackRow | null {
  const isrc = normalizeIsrc(q.isrc);
  if (isrc) {
    const rows = db.prepare(`${SELECT} WHERE t.isrc = ?`).all(isrc) as Cand[];
    if (rows.length) return rankVariants(rows, preferHiRes)[0];
  }
  if (!q.title || !q.artist) return null;

  const nTitle = normalize(q.title);
  const nArtist = normalize(q.artist);
  const nPrimary = primaryArtist(q.artist);
  if (!nTitle || !nArtist) return null;

  const rows = db.prepare(`${SELECT} WHERE t.norm_title = ?`).all(nTitle) as Cand[];
  const wantSec = q.durationMs && q.durationMs > 0 ? q.durationMs / 1000 : null;

  const ok = rows.filter((t) => {
    const artistOk = t.norm_artist === nArtist || (nPrimary !== '' && (t.norm_artist === nPrimary || primaryArtist(t.artist) === nPrimary));
    if (!artistOk) return false;
    if (t.duration_sec == null) return cfg.match.allowUnknownDuration;
    if (wantSec == null) return false; // strict: need a duration to verify against
    return Math.abs(t.duration_sec - wantSec) <= cfg.match.toleranceSec;
  });
  return ok.length ? rankVariants(ok, preferHiRes)[0] : null;
}

/** Sibling copies of the same recording (other releases) — lets /stream honour preferHiRes. */
export function bestVariant(db: DB, track: TrackRow, preferHiRes: boolean): TrackRow {
  const rows = db.prepare(`${SELECT} WHERE t.norm_title = ? AND t.norm_artist = ?`).all(track.norm_title, track.norm_artist) as Cand[];
  const same = rows.filter(
    (r) => r.id === track.id || (r.duration_sec != null && track.duration_sec != null ? Math.abs(r.duration_sec - track.duration_sec) <= 3 : false),
  );
  return rankVariants(same.length ? same : [track as Cand], preferHiRes)[0];
}
