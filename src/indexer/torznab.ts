import { XMLParser } from 'fast-xml-parser';
import type { Config } from '../config.js';
import { parseMagnet } from './magnet.js';
import type { IndexItem } from './types.js';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const HASH_RE = /^[0-9a-f]{40}$/i;

/** Parse a Torznab XML (or Prowlarr/Jackett JSON) response into IndexItems. */
export function parseTorznabResponse(body: string): IndexItem[] {
  const t = body.trimStart();
  if (t.startsWith('[') || t.startsWith('{')) return parseJsonResults(JSON.parse(t));
  const doc = xml.parse(body);
  if (doc?.error) throw new Error(`torznab error ${doc.error['@_code']}: ${doc.error['@_description']}`);
  const items = arr<any>(doc?.rss?.channel?.item);
  return items.map((it) => {
    const attrs: Record<string, string> = {};
    for (const a of arr<any>(it['torznab:attr'] ?? it.attr)) attrs[a['@_name']] = a['@_value'];
    const link: string | undefined = typeof it.link === 'string' ? it.link : undefined;
    const enclosure = it.enclosure?.['@_url'] as string | undefined;
    const magnet = attrs.magneturl ?? (link?.startsWith('magnet:') ? link : undefined);
    const torrentUrl = [enclosure, link].find((u) => u && !u.startsWith('magnet:'));
    const infohash = (attrs.infohash && HASH_RE.test(attrs.infohash) ? attrs.infohash : undefined)?.toLowerCase();
    return {
      title: String(it.title ?? ''),
      infohash,
      magnet,
      torrentUrl,
      size: Number(attrs.size ?? it.size ?? it.enclosure?.['@_length']) || undefined,
      seeders: attrs.seeders !== undefined ? Number(attrs.seeders) : undefined,
    };
  }).filter((i) => i.title);
}

/** Generic JSON catalog shape: array or {items|results|releases:[...]} of {title, infohash|hash, magnet|magnetUrl|magneturl, link, size, seeders}. */
export function parseJsonResults(j: any): IndexItem[] {
  const list: any[] = Array.isArray(j) ? j : j?.items ?? j?.results ?? j?.releases ?? j?.torrents ?? [];
  return list
    .map((r): IndexItem => {
      const hash = String(r.infohash ?? r.infoHash ?? r.hash ?? '').toLowerCase();
      const magnet = r.magnet ?? r.magnetUrl ?? r.magneturl ?? r.magnetUri ?? (String(r.guid ?? '').startsWith('magnet:') ? r.guid : undefined);
      const link: string | undefined = r.downloadUrl ?? r.link ?? r.torrent ?? r.torrentUrl;
      return {
        title: String(r.title ?? r.name ?? ''),
        infohash: HASH_RE.test(hash) ? hash : undefined,
        magnet: magnet ?? (link?.startsWith('magnet:') ? link : undefined),
        torrentUrl: link && !link.startsWith('magnet:') ? link : undefined,
        size: Number(r.size) || undefined,
        seeders: r.seeders !== undefined ? Number(r.seeders) : undefined,
      };
    })
    .filter((i) => i.title && (i.infohash || i.magnet || i.torrentUrl));
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'losslesscloud/1.0' } });
  if (!res.ok) throw new Error(`torznab HTTP ${res.status}`);
  return res.text();
}

/**
 * Query every configured Torznab endpoint. `t=music` first, then `t=search&cat=3040` (Lossless Audio) when empty.
 * Failures of one endpoint never fail the whole search.
 */
export async function searchTorznab(cfg: Config, q: string, timeoutMs = cfg.onDemandTimeoutMs): Promise<IndexItem[]> {
  const out: IndexItem[] = [];
  await Promise.all(
    cfg.torznab.endpoints.map(async ({ url, apiKey }) => {
      const mk = (params: Record<string, string>) => {
        const u = new URL(url);
        if (apiKey) u.searchParams.set('apikey', apiKey);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        return u.toString();
      };
      try {
        let items = parseTorznabResponse(await fetchText(mk({ t: 'music', q, cat: cfg.torznab.categories, extended: '1' }), timeoutMs));
        if (!items.length)
          items = parseTorznabResponse(await fetchText(mk({ t: 'search', q, cat: cfg.torznab.categories, extended: '1' }), timeoutMs));
        out.push(...items);
      } catch (e) {
        console.warn(`[torznab] ${new URL(url).host}: ${(e as Error).message}`);
      }
    }),
  );
  // de-dup by infohash/magnet-hash/title
  const seen = new Set<string>();
  return out.filter((i) => {
    const k = i.infohash ?? (i.magnet && parseMagnet(i.magnet)?.infohash) ?? i.title;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
