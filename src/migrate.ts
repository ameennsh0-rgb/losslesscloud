import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Ordered migrations; PRAGMA user_version tracks how many have been applied. */
export const MIGRATIONS: string[] = [
  /* 1: core schema */ `
CREATE TABLE releases (
  id            INTEGER PRIMARY KEY,
  infohash      TEXT NOT NULL UNIQUE,            -- lowercase 40-char hex SHA-1
  title         TEXT NOT NULL,                   -- raw release title
  artist        TEXT,
  album         TEXT,
  year          INTEGER,
  magnet        TEXT,
  torrent_url   TEXT,
  size          INTEGER,
  seeders       INTEGER,
  bit_depth     INTEGER,
  sample_rate   INTEGER,
  source        TEXT,                            -- torznab | feed | torrent | manual
  files_indexed INTEGER NOT NULL DEFAULT 0,      -- 1 once the file tree was parsed
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_releases_files ON releases(files_indexed);

CREATE TABLE tracks (
  id            INTEGER PRIMARY KEY,
  release_id    INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,                   -- path inside the torrent
  disc          INTEGER NOT NULL DEFAULT 1,
  track_no      INTEGER,
  title         TEXT NOT NULL,
  artist        TEXT,
  album         TEXT,
  isrc          TEXT,
  duration_sec  REAL,                            -- learned lazily from FLAC STREAMINFO
  bit_depth     INTEGER,
  sample_rate   INTEGER,
  size          INTEGER,
  norm_artist   TEXT NOT NULL DEFAULT '',
  norm_title    TEXT NOT NULL DEFAULT '',
  UNIQUE (release_id, file_path)
);
CREATE INDEX idx_tracks_release ON tracks(release_id);
CREATE INDEX idx_tracks_isrc ON tracks(isrc) WHERE isrc IS NOT NULL;
CREATE INDEX idx_tracks_norm ON tracks(norm_artist, norm_title);

-- FTS5 (external-content) over tracks, kept in sync by triggers
CREATE VIRTUAL TABLE tracks_fts USING fts5(
  title, artist, album,
  content='tracks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER tracks_ai AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts(rowid, title, artist, album) VALUES (new.id, new.title, new.artist, new.album);
END;
CREATE TRIGGER tracks_ad AFTER DELETE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album) VALUES ('delete', old.id, old.title, old.artist, old.album);
END;
CREATE TRIGGER tracks_au AFTER UPDATE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album) VALUES ('delete', old.id, old.title, old.artist, old.album);
  INSERT INTO tracks_fts(rowid, title, artist, album) VALUES (new.id, new.title, new.artist, new.album);
END;

-- FTS5 over releases (album search)
CREATE VIRTUAL TABLE releases_fts USING fts5(
  title, artist, album,
  content='releases', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER releases_ai AFTER INSERT ON releases BEGIN
  INSERT INTO releases_fts(rowid, title, artist, album) VALUES (new.id, new.title, new.artist, new.album);
END;
CREATE TRIGGER releases_ad AFTER DELETE ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, title, artist, album) VALUES ('delete', old.id, old.title, old.artist, old.album);
END;
CREATE TRIGGER releases_au AFTER UPDATE ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, title, artist, album) VALUES ('delete', old.id, old.title, old.artist, old.album);
  INSERT INTO releases_fts(rowid, title, artist, album) VALUES (new.id, new.title, new.artist, new.album);
END;

-- Resolved CDN URLs (per track, per TorBox account: URLs embed the user's token)
CREATE TABLE stream_cache (
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL,                     -- sha256(torboxKey) prefix, never the key itself
  url         TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,                  -- epoch ms
  torrent_id  INTEGER,
  file_id     INTEGER,
  sample_rate INTEGER,
  bit_depth   INTEGER,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (track_id, key_hash)
);
CREATE INDEX idx_stream_cache_exp ON stream_cache(expires_at);

-- infohash -> TorBox torrent_id, per account
CREATE TABLE torbox_map (
  key_hash   TEXT NOT NULL,
  infohash   TEXT NOT NULL,
  torrent_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key_hash, infohash)
);

-- When a query was last fanned out to the indexers (staleness check for /search)
CREATE TABLE search_log (
  query       TEXT PRIMARY KEY,
  searched_at INTEGER NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0
);
`,
];

export function migrate(db: Database.Database): number {
  let v = db.pragma('user_version', { simple: true }) as number;
  for (; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return v;
}

export function openDb(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

// `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadConfig } = await import('./config.js');
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  console.log(`Schema at version ${db.pragma('user_version', { simple: true })} (${cfg.dbPath})`);
  db.close();
}
