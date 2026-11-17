import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { DB, ReleaseRow, TrackRow } from '../db.js';
import { probeFlac } from '../indexer/flacHeader.js';
import { buildMagnet } from '../indexer/magnet.js';
import { NotCachedError, TorboxClient, TorboxError, UncachedLimiter, type TorboxFile } from './client.js';

export class PreparingError extends Error { constructor(readonly progress?: number) { super('Archive is still being prepared'); } }
export class RateLimitedError extends Error { constructor(readonly retryAfterSec: number) { super('Uncached add rate limit reached'); } }
export class MissingKeyError extends Error { constructor() { super('No TorBox API key configured'); } }

export interface StreamResult {
  url: string; format: 'flac'; quality: string; codec: 'flac'; container: 'flac';
  manifest: 'none'; encrypted: false; sampleRate: number; bitDepth: number; expiresAt: string;
}

export const keyHash = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);
const norm = (s: string) => s.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

/** Match our indexed path to TorBox's file list (TorBox prefixes paths with the torrent name). */
export function findTorboxFile(files: TorboxFile[], path: string): TorboxFile | undefined {
  const want = norm(path);
  return (
    files.find((f) => norm(f.name) === want) ??
    files.find((f) => norm(f.name).endsWith('/' + want) || want.endsWith('/' + norm(f.name))) ??
    // last resort: same basename and same size
    files.find((f) => norm(f.name).split('/').pop() === want.split('/').pop())
  );
}

export class StreamService {
  readonly limiter = new UncachedLimiter(60, 3600_000);
  constructor(private db: DB, private cfg: Config) {}

  async resolve(track: TrackRow, opts: { torboxKey: string; cachedOnly: boolean }): Promise<StreamResult> {
    const key = opts.torboxKey || this.cfg.torbox.apiKey;
    if (!key) throw new MissingKeyError();
    const kh = keyHash(key);
    const now = Date.now();

    const hit = this.db.prepare('SELECT * FROM stream_cache WHERE track_id = ? AND key_hash = ?').get(track.id, kh) as any;
    if (hit && hit.expires_at - now > 5 * 60_000) return this.toResult(hit.url, hit.expires_at, hit.sample_rate ?? track.sample_rate, hit.bit_depth ?? track.bit_depth);

    const release = this.db.prepare('SELECT * FROM releases WHERE id = ?').get(track.release_id) as ReleaseRow;
    const tb = new TorboxClient(key, this.cfg.torbox);

    // 1. torrent in this account's cloud storage?
    let torrentId = (this.db.prepare('SELECT torrent_id FROM torbox_map WHERE key_hash = ? AND infohash = ?').get(kh, release.infohash) as { torrent_id: number } | undefined)?.torrent_id;

    if (!torrentId) {
      const magnet = release.magnet ?? buildMagnet(release.infohash, release.title);
      const cached = (await tb.checkCached([release.infohash])).has(release.infohash);
      if (cached) {
        torrentId = (await tb.createTorrent(magnet, { addOnlyIfCached: true })).torrent_id;
      } else {
        if (opts.cachedOnly) throw new NotCachedError();
        const gate = this.limiter.tryAcquire(kh);
        if (!gate.ok) throw new RateLimitedError(gate.retryAfterSec);
        torrentId = (await tb.createTorrent(magnet, { addOnlyIfCached: false })).torrent_id;
      }
      this.db.prepare('INSERT OR REPLACE INTO torbox_map (key_hash, infohash, torrent_id, created_at) VALUES (?,?,?,?)').run(kh, release.infohash, torrentId, now);
    }

    // 2. file lookup
    let t;
    try {
      t = await tb.myList(torrentId);
    } catch (e) {
      if (e instanceof TorboxError && e.status === 404) { // removed from the account → forget mapping, retry once
        this.db.prepare('DELETE FROM torbox_map WHERE key_hash = ? AND infohash = ?').run(kh, release.infohash);
        throw new PreparingError();
      }
      throw e;
    }
    if (!t || (!t.download_finished && !t.download_present) || !t.files?.length) throw new PreparingError(t?.progress);
    const file = findTorboxFile(t.files, track.file_path);
    if (!file) throw new TorboxError(`File not found in torrent: ${track.file_path}`, 404, 'FILE_NOT_FOUND');

    // 3. CDN link (~3h)
    const url = await tb.requestDownload(torrentId, file.id);
    const expiresAt = now + this.cfg.torbox.urlTtlMs;

    // 4. read STREAMINFO (exact spec + duration) and persist for future /resolve
    const info = await probeFlac(url);
    const sampleRate = info?.sampleRate ?? track.sample_rate;
    const bitDepth = info?.bitDepth ?? track.bit_depth;
    if (info) {
      this.db.prepare('UPDATE tracks SET duration_sec = ?, sample_rate = ?, bit_depth = ? WHERE id = ?').run(info.durationSec, info.sampleRate, info.bitDepth, track.id);
    }
    this.db.prepare(`INSERT OR REPLACE INTO stream_cache (track_id,key_hash,url,expires_at,torrent_id,file_id,sample_rate,bit_depth,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(track.id, kh, url, expiresAt, torrentId, file.id, sampleRate, bitDepth, now);
    return this.toResult(url, expiresAt, sampleRate, bitDepth);
  }

  private toResult(url: string, expiresAt: number, sampleRate: number | null, bitDepth: number | null): StreamResult {
    const sr = sampleRate ?? 44100, bd = bitDepth ?? 16;
    return {
      url, format: 'flac', quality: `${bd}-bit/${+(sr / 1000).toFixed(1)}kHz FLAC`, codec: 'flac', container: 'flac',
      manifest: 'none', encrypted: false, sampleRate: sr, bitDepth: bd, expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  purgeExpired() {
    this.db.prepare('DELETE FROM stream_cache WHERE expires_at < ?').run(Date.now());
  }
}
