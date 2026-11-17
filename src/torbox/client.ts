import type { Config } from '../config.js';

export class TorboxError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

export interface CachedEntry { hash: string; name?: string; size?: number; files: { name: string; size: number }[] }
export interface TorboxFile { id: number; name: string; short_name?: string; size: number }
export interface TorboxTorrent {
  id: number; hash: string; name: string; progress?: number;
  download_finished?: boolean; download_present?: boolean; download_state?: string;
  files: TorboxFile[];
}

/** Thin typed wrapper over TorBox API v1 (`Authorization: Bearer <key>`). */
export class TorboxClient {
  constructor(private key: string, private cfg: Config['torbox']) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.key}`, 'User-Agent': 'losslesscloud/1.0', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok || body?.success === false) {
      throw new TorboxError(body?.detail ?? body?.error ?? `TorBox HTTP ${res.status}`, res.status, body?.error ?? undefined);
    }
    return body?.data as T;
  }

  /** Batch cache check; with list_files=true each cached hash includes its file list. Uncached hashes are omitted. */
  async checkCached(hashes: string[]): Promise<Map<string, CachedEntry>> {
    const out = new Map<string, CachedEntry>();
    for (let i = 0; i < hashes.length; i += 50) {
      const chunk = hashes.slice(i, i + 50);
      const data = await this.req<any>(`/torrents/checkcached?hash=${chunk.join(',')}&format=list&list_files=true`);
      for (const e of Array.isArray(data) ? data : []) {
        out.set(String(e.hash).toLowerCase(), {
          hash: String(e.hash).toLowerCase(),
          name: e.name,
          size: e.size,
          files: (e.files ?? []).map((f: any) => ({ name: String(f.name), size: Number(f.size) })),
        });
      }
    }
    return out;
  }

  /** Add to cloud storage. `addOnlyIfCached` makes TorBox refuse (instead of starting a download) when not cached. */
  async createTorrent(magnet: string, opts: { addOnlyIfCached: boolean }): Promise<{ torrent_id: number }> {
    const form = new FormData();
    form.set('magnet', magnet);
    form.set('seed', '3'); // don't seed
    form.set('allow_zip', 'false');
    if (opts.addOnlyIfCached) form.set('add_only_if_cached', 'true');
    try {
      const d = await this.req<any>('/torrents/createtorrent', { method: 'POST', body: form });
      return { torrent_id: Number(d.torrent_id ?? d.id) };
    } catch (e) {
      if (e instanceof TorboxError && /CACHED/i.test(`${e.code} ${e.message}`)) throw new NotCachedError();
      throw e;
    }
  }

  async myList(id: number): Promise<TorboxTorrent> {
    const d = await this.req<any>(`/torrents/mylist?id=${id}&bypass_cache=true`);
    return Array.isArray(d) ? d[0] : d;
  }

  /** `redirect=false` → JSON containing the CDN URL instead of a 302. */
  async requestDownload(torrentId: number, fileId: number): Promise<string> {
    const url = `/torrents/requestdl?token=${encodeURIComponent(this.key)}&torrent_id=${torrentId}&file_id=${fileId}&redirect=false`;
    return this.req<string>(url);
  }
}

export class NotCachedError extends Error { constructor() { super('Torrent is not cached on TorBox'); } }

/** Sliding-window limiter for uncached adds (TorBox allows 60/hour). Keyed per account. */
export class UncachedLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = 60, private windowMs = 3600_000) {}
  tryAcquire(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterSec: Math.ceil((arr[0] + this.windowMs - now) / 1000) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { ok: true };
  }
}
