import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { TorboxClient } from '../torbox/client.js';
import { normalize } from '../matcher/normalize.js';
import { parseTorrent, type TorrentFile } from './bencode.js';
import { isFlac, parseAudioSpec, parseReleaseTitle, parseTrackPath } from './flacPath.js';
import { buildMagnet, parseMagnet } from './magnet.js';
import type { IndexItem } from './types.js';

async function fetchTorrentOrMagnet(url: string): Promise<{ torrent?: Buffer; magnet?: string }> {
  // Prowlarr/Jackett proxy links sometimes 302 straight to a magnet: URI, which fetch can't follow.
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'losslesscloud/1.0' } });
  const loc = res.headers.get('location');
  if (loc?.startsWith('magnet:')) return { magnet: loc };
  if (loc) return fetchTorrentOrMagnet(new URL(loc, url).toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { torrent: Buffer.from(await res.arrayBuffer()) };
}

export interface IngestResult { releases: number; tracks: number }

/**
 * Resolve infohash + file tree for each item (bencode / magnet / TorBox cache listing),
 * then upsert releases and tracks. Safe to call repeatedly; existing releases are only refreshed.
 */
export async function ingestItems(db: DB, cfg: Config, items: IndexItem[], source: string): Promise<IngestResult> {
  const now = Date.now();
  type Pending = { infohash: string; item: IndexItem; magnet: string; files?: TorrentFile[]; name?: string };
  const pending: Pending[] = [];

  for (const item of items) {
    try {
      let infohash = item.infohash;
      let magnet = item.magnet;
      let files: TorrentFile[] | undefined;
      let name: string | undefined;
      if (magnet && !infohash) infohash = parseMagnet(magnet)?.infohash;

      const known = infohash ? (db.prepare('SELECT files_indexed FROM releases WHERE infohash = ?').get(infohash) as { files_indexed: number } | undefined) : undefined;
      if (!known?.files_indexed && item.torrentUrl) {
        try {
          const r = await fetchTorrentOrMagnet(item.torrentUrl);
          if (r.torrent) {
            const t = parseTorrent(r.torrent);
            infohash = t.infohash; files = t.files; name = t.name;
            magnet ??= buildMagnet(t.infohash, t.name);
          } else if (r.magnet) {
            magnet = r.magnet;
            infohash ??= parseMagnet(r.magnet)?.infohash;
          }
        } catch (e) {
          console.warn(`[ingest] torrent fetch failed for "${item.title}": ${(e as Error).message}`);
        }
      }
      if (!infohash) continue;
      pending.push({ infohash, item, magnet: magnet ?? buildMagnet(infohash, item.title), files, name });
    } catch (e) {
      console.warn(`[ingest] skip "${item.title}": ${(e as Error).message}`);
    }
  }

  // Magnet-only releases: ask TorBox which are cached and take the file list from there (no media bytes).
  const needFiles = pending.filter((p) => !p.files && !db.prepare('SELECT 1 FROM releases WHERE infohash = ? AND files_indexed = 1').get(p.infohash));
  if (needFiles.length && cfg.torbox.apiKey) {
    try {
      const cached = await new TorboxClient(cfg.torbox.apiKey, cfg.torbox).checkCached(needFiles.map((p) => p.infohash));
      for (const p of needFiles) {
        const c = cached.get(p.infohash);
        if (c) p.files = c.files.map((f) => ({ path: f.name, size: f.size }));
      }
    } catch (e) {
      console.warn(`[ingest] TorBox file listing failed: ${(e as Error).message}`);
    }
  }

  const upsertRelease = db.prepare(`
    INSERT INTO releases (infohash,title,artist,album,year,magnet,torrent_url,size,seeders,bit_depth,sample_rate,source,files_indexed,created_at,updated_at)
    VALUES (@infohash,@title,@artist,@album,@year,@magnet,@torrent_url,@size,@seeders,@bit_depth,@sample_rate,@source,0,@now,@now)
    ON CONFLICT(infohash) DO UPDATE SET seeders=COALESCE(excluded.seeders,seeders), size=COALESCE(excluded.size,size),
      magnet=COALESCE(magnet,excluded.magnet), torrent_url=COALESCE(excluded.torrent_url,torrent_url), updated_at=excluded.updated_at
    RETURNING id, files_indexed`);
  const insertTrack = db.prepare(`
    INSERT OR IGNORE INTO tracks (release_id,file_path,disc,track_no,title,artist,album,bit_depth,sample_rate,size,norm_artist,norm_title)
    VALUES (@release_id,@file_path,@disc,@track_no,@title,@artist,@album,@bit_depth,@sample_rate,@size,@norm_artist,@norm_title)`);
  const markIndexed = db.prepare('UPDATE releases SET files_indexed = 1 WHERE id = ?');

  let releases = 0, tracks = 0;
  db.transaction(() => {
    for (const p of pending) {
      const pr = parseReleaseTitle(p.item.title);
      const row = upsertRelease.get({
        infohash: p.infohash, title: p.item.title, artist: pr.artist, album: pr.album, year: pr.year,
        magnet: p.magnet, torrent_url: p.item.torrentUrl ?? null, size: p.item.size ?? null, seeders: p.item.seeders ?? null,
        bit_depth: pr.spec.bitDepth, sample_rate: pr.spec.sampleRate, source, now,
      }) as { id: number; files_indexed: number };
      releases++;
      if (row.files_indexed || !p.files) continue;
      const flacs = p.files.filter((f) => isFlac(f.path));
      if (!flacs.length) continue;
      // folder names sometimes carry the spec when the release title doesn't
      const spec = pr.spec.bitDepth ? pr.spec : parseAudioSpec(flacs[0].path);
      for (const f of flacs) {
        const t = parseTrackPath(f.path, pr.artist);
        const artist = t.artist ?? pr.artist;
        tracks += insertTrack.run({
          release_id: row.id, file_path: f.path, disc: t.disc, track_no: t.trackNo, title: t.title, artist, album: pr.album,
          bit_depth: spec.bitDepth, sample_rate: spec.sampleRate, size: f.size,
          norm_artist: normalize(artist), norm_title: normalize(t.title),
        }).changes;
      }
      markIndexed.run(row.id);
    }
  })();
  return { releases, tracks };
}
