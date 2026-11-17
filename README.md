# Lossless Cloud Audio — Eclipse Music / BitChord addon

Self-hosted HTTP JSON addon (Node 20+, Fastify, SQLite FTS5) that indexes lossless FLAC torrents
(Torznab / RSS / JSON feeds, `.torrent` + magnet parsing) and streams them through the TorBox cloud API.
No media bytes are ever downloaded by the server.

## Run
    cp .env.example .env      # set TORZNAB_URL / TORZNAB_API_KEY / TORBOX_API_KEY
    npm install
    npm run migrate           # optional: the server also migrates on boot
    npm run dev               # or: npm run build && npm start
    npm test

Docker: `docker build -t losslesscloud . && docker run -d -p 8787:8787 -v lc-data:/data --env-file .env losslesscloud`.
`docker-compose.yml` adds Caddy for automatic HTTPS (edit the domain). Add `https://your.domain/manifest.json` in the app.

## Endpoints
| Route | Notes |
|---|---|
| `GET /manifest.json` | resources, types, settings (`torboxKey`, `cachedOnly`, `preferHiRes`) |
| `GET /search?q=` | FTS5 first; if stale (`SEARCH_TTL_HOURS`) or empty → Torznab lookup, ingest, re-query |
| `GET /album/{id}` | full tracklist (`alb-<n>`) |
| `GET /resolve-isrc?isrc=` · `GET /resolve?isrc&title&artist&durationMs` | exact ISRC, else normalized artist+title and duration ±3 s; `404 {"item":null}` otherwise |
| `GET /stream/{id}?torboxKey=&cachedOnly=&preferHiRes=` | TorBox flow; `503` + `Retry-After: 5` + notice while preparing |

## Design notes
- **Durations / specs**: torrents don't carry track length. On the first successful `/stream`, the server range-reads the first bytes of the CDN FLAC, parses STREAMINFO, and stores exact duration, sample rate and bit depth. Strict duration matching in `/resolve` therefore only matches tracks that have been streamed once, unless `MATCH_ALLOW_UNKNOWN_DURATION=true` (title+artist only).
- **ISRC**: torrents carry none; the `tracks.isrc` column is there for manual/feed enrichment (a `isrc` field in a JSON feed item is not read yet — see `src/indexer/ingest.ts`).
- **Magnet-only releases**: file lists come from TorBox `checkcached?list_files=true` using `TORBOX_API_KEY`; uncached magnets stay un-indexed until a `.torrent` is available.
- **Per-account**: stream URLs and torrent ids are cached per sha256(torboxKey); the key itself is never stored and is redacted from logs.
- **Uncached adds** (when `cachedOnly=false`) are limited to 60/hour per key in-process (`429` + `Retry-After`).
- Node/SQLite only; a Cloudflare Workers build is not included (better-sqlite3 and the background poller don't run there).
