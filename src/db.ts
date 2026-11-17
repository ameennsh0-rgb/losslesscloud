import type Database from 'better-sqlite3';
export type DB = Database.Database;

export interface ReleaseRow {
  id: number; infohash: string; title: string; artist: string | null; album: string | null;
  year: number | null; magnet: string | null; torrent_url: string | null; size: number | null;
  seeders: number | null; bit_depth: number | null; sample_rate: number | null;
  source: string | null; files_indexed: number; created_at: number; updated_at: number;
}
export interface TrackRow {
  id: number; release_id: number; file_path: string; disc: number; track_no: number | null;
  title: string; artist: string | null; album: string | null; isrc: string | null;
  duration_sec: number | null; bit_depth: number | null; sample_rate: number | null;
  size: number | null; norm_artist: string; norm_title: string;
}
