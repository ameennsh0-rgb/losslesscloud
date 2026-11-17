/**
 * String normalisation for matching. Edition/remaster clutter is stripped unless
 * `keepEdition` is set (e.g. the user explicitly searched for "2011 remaster").
 */
const EDITION_WORDS =
  '(?:re-?master(?:ed)?|deluxe|edition|anniversary|bonus(?: tracks?)?|expanded|re-?issue|mono|stereo|super deluxe)';
const BRACKETED = new RegExp(`[\\(\\[\\{][^\\)\\]\\}]*\\b${EDITION_WORDS}\\b[^\\)\\]\\}]*[\\)\\]\\}]`, 'gi');
const TRAILING = new RegExp(`\\s[-–—]\\s*(?:\\d{4}\\s+)?${EDITION_WORDS}(?:\\s+\\d{4})?[^-–—]*$`, 'i');
const FEAT_BRACKET = /[\(\[]\s*(?:feat\.?|ft\.?|featuring)\s[^\)\]]*[\)\]]/gi;
const FEAT_TRAIL = /\s(?:feat\.?|ft\.?|featuring)\s.*$/i;

export function hasEditionHint(s: string): boolean {
  return new RegExp(`\\b${EDITION_WORDS}\\b`, 'i').test(s);
}

export function normalize(input: string | null | undefined, opts: { keepEdition?: boolean } = {}): string {
  if (!input) return '';
  let s = input;
  if (!opts.keepEdition) s = s.replace(BRACKETED, ' ').replace(TRAILING, ' ');
  s = s.replace(FEAT_BRACKET, ' ').replace(FEAT_TRAIL, ' ');
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/^the /, '')
    .trim();
}

/** First artist of a "A & B", "A feat. B", "A, B" credit — used as a looser fallback key. */
export function primaryArtist(s: string | null | undefined): string {
  if (!s) return '';
  return normalize(s.split(/\s*(?:,|&|\band\b|feat\.?|ft\.?|featuring|\/|;|\bx\b)\s*/i)[0]);
}

export function normalizeIsrc(s: string | null | undefined): string | null {
  const v = (s ?? '').replace(/[-\s]/g, '').toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(v) ? v : null;
}
