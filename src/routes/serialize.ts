import type { ReleaseRow, TrackRow } from '../db.js';

export const trackId = (id: number) => `trk-${id}`;
export const albumId = (id: number) => `alb-${id}`;
export const parseId = (s: string, prefix: 'trk' | 'alb'): number | null => {
  const m = new RegExp(`^${prefix}-(\\d+)$`).exec(s);
  return m ? Number(m[1]) : null;
};

export function trackJson(t: TrackRow) {
  return {
    id: trackId(t.id),
    title: t.title,
    artist: t.artist ?? 'Unknown Artist',
    album: t.album ?? '',
    albumId: albumId(t.release_id),
    trackNumber: t.track_no,
    discNumber: t.disc,
    duration: t.duration_sec != null ? Math.round(t.duration_sec) : null,
    format: 'flac' as const,
    ...(t.isrc ? { isrc: t.isrc } : {}),
    ...(t.bit_depth ? { bitDepth: t.bit_depth } : {}),
    ...(t.sample_rate ? { sampleRate: t.sample_rate } : {}),
  };
}

export function albumJson(r: ReleaseRow, trackCount: number) {
  return {
    id: albumId(r.id),
    title: r.album ?? r.title,
    artist: r.artist ?? 'Unknown Artist',
    year: r.year,
    trackCount,
    format: 'flac' as const,
    ...(r.bit_depth ? { bitDepth: r.bit_depth } : {}),
    ...(r.sample_rate ? { sampleRate: r.sample_rate } : {}),
  };
}
