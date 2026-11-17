import { normalize } from '../matcher/normalize.js';

export interface AudioSpec { bitDepth: number | null; sampleRate: number | null }

/** "24bit-96kHz", "24-96", "[FLAC 16-44.1]", "24 bit / 192 kHz" → spec. */
const RATE_MAP: Record<string, number> = {
  '44': 44100, '44.1': 44100, '441': 44100, '48': 48000, '88': 88200, '88.2': 88200, '882': 88200,
  '96': 96000, '176': 176400, '176.4': 176400, '1764': 176400, '192': 192000,
};

export function parseAudioSpec(s: string): AudioSpec {
  let bitDepth: number | null = null;
  let sampleRate: number | null = null;
  const pair = /\b(16|24|32)\s*[-/]\s*(44\.?1|48|88\.?2|96|176\.?4|192)\b/.exec(s);
  if (pair) {
    bitDepth = Number(pair[1]);
    sampleRate = RATE_MAP[pair[2]] ?? null;
  }
  const bd = /\b(16|24|32)\s*-?\s*bit\b/i.exec(s);
  if (bd) bitDepth = Number(bd[1]);
  const sr = /(\d{2,3}(?:\.\d)?)\s*khz/i.exec(s);
  if (sr) sampleRate = RATE_MAP[sr[1]] ?? Math.round(Number(sr[1]) * 1000);
  return { bitDepth, sampleRate };
}

export interface ParsedRelease {
  artist: string | null;
  album: string;
  year: number | null;
  spec: AudioSpec;
  isVA: boolean;
}

/** "Artist - Album (2013) [FLAC 24bit-96kHz]" and common scene variants. */
export function parseReleaseTitle(raw: string): ParsedRelease {
  const spec = parseAudioSpec(raw);
  const ym = /[\(\[](19|20)(\d{2})[\)\]]|\b(19|20)\d{2}\b(?=\s*[\(\[]|$|\s*-)/.exec(raw);
  const year = ym ? Number(ym[0].replace(/\D/g, '').slice(0, 4)) : null;
  let s = raw
    .replace(/[\(\[][^\)\]]*\b(flac|web|cd|vinyl|lossless|hi-?res|24\s*-?\s*bit|16\s*-?\s*bit|\d{2,3}\s*k?hz|(?:19|20)\d{2})\b[^\)\]]*[\)\]]/gi, ' ')
    .replace(/[._](?=\S)/g, (m) => (/\s/.test(m) ? m : ' '))
    .replace(/-[A-Za-z0-9]{2,12}$/, '') // trailing -GROUP
    .replace(/\s+/g, ' ')
    .trim();
  const sep = s.indexOf(' - ');
  let artist: string | null = null;
  let album = s;
  if (sep > 0) {
    artist = s.slice(0, sep).trim();
    album = s.slice(sep + 3).trim();
  }
  album = album.replace(/\b(FLAC|WEB|CD|Lossless)\b.*$/i, '').replace(/[-\s]+$/, '').trim() || s;
  const isVA = !!artist && /^(various artists?|va|v\.a\.)$/i.test(artist);
  return { artist, album, year, spec, isVA };
}

export interface ParsedTrackPath {
  disc: number;
  trackNo: number | null;
  title: string;
  artist: string | null;
}

const AUDIO_EXT = /\.flac$/i;
export const isFlac = (p: string) => AUDIO_EXT.test(p);

/**
 * Parse a path inside a release:
 *   "Album/01 - Track Name.flac", "Album/CD1/02. Artist - Title.flac", "Album/1-05 Title.flac", "Album/101 Title.flac"
 */
export function parseTrackPath(path: string, releaseArtist?: string | null): ParsedTrackPath {
  const segs = path.split(/[\\/]/).filter(Boolean);
  const file = (segs.pop() ?? path).replace(AUDIO_EXT, '');
  let disc = 1;
  for (const seg of segs) {
    const m = /^(?:cd|dis[ck]|vol(?:ume)?)\s*[-_. ]?\s*0*(\d{1,2})\b/i.exec(seg);
    if (m) disc = Number(m[1]);
  }

  let trackNo: number | null = null;
  let rest = file;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2})[-.](\d{1,3})(?:\s*[-._)]\s*|\s+)(.+)$/.exec(file))) {
    disc = Number(m[1]); trackNo = Number(m[2]); rest = m[3];            // 1-05 Title / 2.03 - Title
  } else if ((m = /^(\d)(\d{2})(?:\s*[-._)]\s*|\s+)(.+)$/.exec(file)) && Number(m[1]) > 0 && disc === 1 && /^\d{3}\b/.test(file)) {
    disc = Number(m[1]); trackNo = Number(m[2]); rest = m[3];            // 101 Title
  } else if ((m = /^(\d{1,3})(?:\s*[-._)]+\s*|\s+)(.+)$/.exec(file))) {
    trackNo = Number(m[1]); rest = m[2];                                  // 01 - Title / 01. Title / 01 Title
  }
  rest = rest.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  let artist: string | null = null;
  let title = rest;
  const sep = rest.indexOf(' - ');
  if (sep > 0) {
    const left = rest.slice(0, sep).trim();
    const right = rest.slice(sep + 3).trim();
    const relNorm = normalize(releaseArtist);
    const isVA = !releaseArtist || /^(various|va\b|v\.a)/i.test(releaseArtist);
    // Only treat the left side as an artist when it agrees with the release artist, or the release is a compilation.
    if (isVA || normalize(left) === relNorm || relNorm.includes(normalize(left)) || normalize(left).includes(relNorm)) {
      artist = left;
      title = right;
    }
  }
  return { disc, trackNo, title: title || file, artist };
}
