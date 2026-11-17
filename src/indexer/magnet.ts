export interface ParsedMagnet { infohash: string; name?: string; trackers: string[] }

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32ToHex(s: string): string {
  let bits = '';
  for (const ch of s.toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    bits += i.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.slice(0, 40);
}

export function parseMagnet(uri: string): ParsedMagnet | null {
  if (!uri.toLowerCase().startsWith('magnet:?')) return null;
  const params = new URLSearchParams(uri.slice(8));
  let infohash = '';
  for (const xt of params.getAll('xt')) {
    const m = /^urn:btih:([a-z0-9]+)$/i.exec(xt);
    if (!m) continue;
    const h = m[1];
    if (/^[0-9a-f]{40}$/i.test(h)) infohash = h.toLowerCase();
    else if (/^[a-z2-7]{32}$/i.test(h)) infohash = base32ToHex(h);
    if (infohash) break;
  }
  if (!infohash) return null;
  return { infohash, name: params.get('dn') ?? undefined, trackers: params.getAll('tr') };
}

export function buildMagnet(infohash: string, name?: string): string {
  return `magnet:?xt=urn:btih:${infohash}${name ? `&dn=${encodeURIComponent(name)}` : ''}`;
}
