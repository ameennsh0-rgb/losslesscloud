import { XMLParser } from 'fast-xml-parser';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { ingestItems } from './ingest.js';
import { parseJsonResults, parseTorznabResponse } from './torznab.js';
import type { IndexItem } from './types.js';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Plain RSS (nyaa-style / tracker feeds) or Torznab XML, or a JSON catalog. */
export function parseFeed(body: string): IndexItem[] {
  const t = body.trimStart();
  if (t.startsWith('[') || t.startsWith('{')) return parseJsonResults(JSON.parse(t));
  const viaTorznab = parseTorznabResponse(body);
  if (viaTorznab.length) return viaTorznab;
  // plain RSS where <link>/<guid> may be magnet or .torrent and the hash lives in <infoHash>
  const doc = xml.parse(body);
  return arr<any>(doc?.rss?.channel?.item).map((it): IndexItem => {
    const link = typeof it.link === 'string' ? it.link : undefined;
    const guid = typeof it.guid === 'string' ? it.guid : it.guid?.['#text'];
    const magnet = [link, guid, it.magnet].find((u) => typeof u === 'string' && u.startsWith('magnet:'));
    const hash = String(it.infoHash ?? it['torrent:infoHash'] ?? '').toLowerCase();
    return {
      title: String(it.title ?? ''),
      infohash: /^[0-9a-f]{40}$/.test(hash) ? hash : undefined,
      magnet,
      torrentUrl: it.enclosure?.['@_url'] ?? (link && !link.startsWith('magnet:') ? link : undefined),
      size: Number(it.enclosure?.['@_length']) || undefined,
    };
  }).filter((i) => i.title && (i.infohash || i.magnet || i.torrentUrl));
}

export async function pollFeedsOnce(db: DB, cfg: Config): Promise<void> {
  for (const url of cfg.feeds.urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'losslesscloud/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseFeed(await res.text());
      const r = await ingestItems(db, cfg, items, 'feed');
      console.log(`[feed] ${new URL(url).host}: ${items.length} items, ${r.releases} releases, +${r.tracks} tracks`);
    } catch (e) {
      console.warn(`[feed] ${url}: ${(e as Error).message}`);
    }
  }
}

/** Background poller that keeps the FTS5 index warm. Returns a stop function. */
export function startFeedPoller(db: DB, cfg: Config): () => void {
  if (!cfg.feeds.urls.length) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await pollFeedsOnce(db, cfg); } finally { running = false; }
  };
  void tick();
  const h = setInterval(tick, cfg.feeds.pollMinutes * 60_000);
  h.unref();
  return () => clearInterval(h);
}
