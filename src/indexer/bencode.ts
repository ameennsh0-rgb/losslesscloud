import { createHash } from 'node:crypto';

export type Bencoded = number | Buffer | Bencoded[] | { [k: string]: Bencoded };

class Decoder {
  pos = 0;
  /** byte span of the top-level "info" dict, for the infohash */
  infoSpan: [number, number] | null = null;
  constructor(readonly buf: Buffer) {}

  value(depth = 0): Bencoded {
    if (depth > 64) throw new Error('bencode: too deep');
    const c = this.buf[this.pos];
    if (c === 0x69 /* i */) {
      const end = this.buf.indexOf(0x65, this.pos);
      if (end < 0) throw new Error('bencode: bad int');
      const n = Number(this.buf.toString('latin1', this.pos + 1, end));
      this.pos = end + 1;
      return n;
    }
    if (c === 0x6c /* l */) {
      this.pos++;
      const out: Bencoded[] = [];
      while (this.buf[this.pos] !== 0x65) {
        if (this.pos >= this.buf.length) throw new Error('bencode: unterminated list');
        out.push(this.value(depth + 1));
      }
      this.pos++;
      return out;
    }
    if (c === 0x64 /* d */) {
      this.pos++;
      const out: { [k: string]: Bencoded } = {};
      while (this.buf[this.pos] !== 0x65) {
        if (this.pos >= this.buf.length) throw new Error('bencode: unterminated dict');
        const key = this.bytes().toString('utf8');
        const start = this.pos;
        out[key] = this.value(depth + 1);
        if (depth === 0 && key === 'info') this.infoSpan = [start, this.pos];
      }
      this.pos++;
      return out;
    }
    if (c >= 0x30 && c <= 0x39) return this.bytes();
    throw new Error(`bencode: unexpected byte ${c} at ${this.pos}`);
  }

  bytes(): Buffer {
    const colon = this.buf.indexOf(0x3a, this.pos);
    if (colon < 0) throw new Error('bencode: bad string');
    const len = Number(this.buf.toString('latin1', this.pos, colon));
    if (!Number.isInteger(len) || len < 0) throw new Error('bencode: bad length');
    const start = colon + 1;
    const end = start + len;
    if (end > this.buf.length) throw new Error('bencode: string overruns buffer');
    this.pos = end;
    return this.buf.subarray(start, end);
  }
}

export function bdecode(buf: Buffer): Bencoded {
  return new Decoder(buf).value();
}

export interface TorrentFile { path: string; size: number }
export interface ParsedTorrent {
  infohash: string;
  name: string;
  files: TorrentFile[];
  totalSize: number;
  trackers: string[];
}

const str = (v: Bencoded | undefined) => (Buffer.isBuffer(v) ? v.toString('utf8') : '');

/** Parse a .torrent file: SHA-1 infohash (over the raw info bytes) + full file tree. No media bytes needed. */
export function parseTorrent(buf: Buffer): ParsedTorrent {
  const d = new Decoder(buf);
  const root = d.value() as { [k: string]: Bencoded };
  if (!d.infoSpan || typeof root.info !== 'object' || Buffer.isBuffer(root.info) || Array.isArray(root.info))
    throw new Error('torrent: missing info dict');
  const infohash = createHash('sha1').update(buf.subarray(d.infoSpan[0], d.infoSpan[1])).digest('hex');
  const info = root.info as { [k: string]: Bencoded };
  const name = str(info['name.utf-8'] ?? info.name);
  const files: TorrentFile[] = [];
  if (Array.isArray(info.files)) {
    for (const f of info.files as { [k: string]: Bencoded }[]) {
      const parts = (f['path.utf-8'] ?? f.path) as Bencoded[];
      files.push({ path: [name, ...parts.map(str)].join('/'), size: Number(f.length) });
    }
  } else {
    files.push({ path: name, size: Number(info.length) });
  }
  const trackers: string[] = [];
  if (root.announce) trackers.push(str(root.announce));
  if (Array.isArray(root['announce-list']))
    for (const tier of root['announce-list'] as Bencoded[]) for (const t of tier as Bencoded[]) trackers.push(str(t));
  return { infohash, name, files, totalSize: files.reduce((a, f) => a + f.size, 0), trackers: [...new Set(trackers)] };
}
