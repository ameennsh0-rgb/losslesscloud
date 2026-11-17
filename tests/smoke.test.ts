import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/migrate.js';
import { parseTorrent } from '../src/indexer/bencode.js';
import { parseMagnet } from '../src/indexer/magnet.js';
import { parseAudioSpec, parseReleaseTitle, parseTrackPath } from '../src/indexer/flacPath.js';
import { parseFlacStreamInfo } from '../src/indexer/flacHeader.js';
import { parseTorznabResponse } from '../src/indexer/torznab.js';
import { ingestItems } from '../src/indexer/ingest.js';
import { normalize } from '../src/matcher/normalize.js';

const benc = (v: any): Buffer => {
  if (typeof v === 'number') return Buffer.from(`i${v}e`);
  if (typeof v === 'string') return Buffer.concat([Buffer.from(`${Buffer.byteLength(v)}:`), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(benc), Buffer.from('e')]);
  const keys = Object.keys(v).sort();
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap((k) => [benc(k), benc(v[k])]), Buffer.from('e')]);
};

test('bencode torrent → infohash + files', () => {
  const info = { name: 'Artist - Album', 'piece length': 16384, pieces: 'x'.repeat(20), files: [
    { length: 100, path: ['CD1', '01 - One.flac'] }, { length: 5, path: ['cover.jpg'] } ] };
  const buf = benc({ announce: 'udp://t', info });
  const t = parseTorrent(buf);
  assert.equal(t.infohash, createHash('sha1').update(benc(info)).digest('hex'));
  assert.deepEqual(t.files.map((f) => f.path), ['Artist - Album/CD1/01 - One.flac', 'Artist - Album/cover.jpg']);
});

test('magnet hex + base32', () => {
  const hex = 'a'.repeat(40);
  assert.equal(parseMagnet(`magnet:?xt=urn:btih:${hex}&dn=x&tr=udp%3A%2F%2Ft`)?.infohash, hex);
  assert.equal(parseMagnet('magnet:?xt=urn:btih:' + 'A'.repeat(32))?.infohash, '0'.repeat(40));
});

test('path + spec parsing', () => {
  assert.deepEqual(parseTrackPath('A/01 - Track Name.flac'), { disc: 1, trackNo: 1, title: 'Track Name', artist: null });
  const p = parseTrackPath('Alb/CD2/02. Daft Punk - Digital Love.flac', 'Various Artists');
  assert.equal(p.disc, 2); assert.equal(p.trackNo, 2); assert.equal(p.artist, 'Daft Punk'); assert.equal(p.title, 'Digital Love');
  const q = parseTrackPath('Alb/1-05 Title.flac'); assert.equal(q.disc, 1); assert.equal(q.trackNo, 5);
  const r = parseTrackPath('Alb/212 Song.flac'); assert.equal(r.disc, 2); assert.equal(r.trackNo, 12);
  assert.deepEqual(parseAudioSpec('Album [FLAC 24bit-96kHz]'), { bitDepth: 24, sampleRate: 96000 });
  assert.deepEqual(parseAudioSpec('Album (24-192) FLAC'), { bitDepth: 24, sampleRate: 192000 });
  assert.deepEqual(parseAudioSpec('Album 16-44.1'), { bitDepth: 16, sampleRate: 44100 });
  const rel = parseReleaseTitle('Daft Punk - Random Access Memories (2013) [FLAC 24bit-88.2kHz]');
  assert.equal(rel.artist, 'Daft Punk'); assert.equal(rel.album, 'Random Access Memories'); assert.equal(rel.year, 2013);
  assert.equal(rel.spec.sampleRate, 88200);
});

test('normalize strips edition clutter', () => {
  assert.equal(normalize('Hey Jude (Remastered 2015)'), 'hey jude');
  assert.equal(normalize('Hey Jude - 2009 Remaster'), 'hey jude');
  assert.equal(normalize('Song (feat. X)'), 'song');
  assert.equal(normalize('Hey Jude (Remastered 2015)', { keepEdition: true }), 'hey jude remastered 2015');
  assert.equal(normalize('Beyoncé & Jay-Z'), 'beyonce and jay z');
});

test('FLAC STREAMINFO', () => {
  const b = Buffer.alloc(42);
  b.write('fLaC', 0, 'latin1'); b[4] = 0x80; b[7] = 34;
  const sr = 96000, ch = 2, bps = 24, total = 96000 * 200;
  b[18] = sr >> 12; b[19] = (sr >> 4) & 0xff; b[20] = ((sr & 0xf) << 4) | ((ch - 1) << 1) | ((bps - 1) >> 4);
  b[21] = (((bps - 1) & 0xf) << 4) | Math.floor(total / 2 ** 32); b.writeUInt32BE(total % 2 ** 32, 22);
  const i = parseFlacStreamInfo(b)!;
  assert.equal(i.sampleRate, 96000); assert.equal(i.bitDepth, 24); assert.equal(i.channels, 2); assert.equal(Math.round(i.durationSec), 200);
});

test('torznab XML', () => {
  const xml = `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item><title>A - B [FLAC]</title>
  <link>http://x/dl</link><enclosure url="http://x/dl.torrent" length="123"/><torznab:attr name="infohash" value="${'b'.repeat(40)}"/>
  <torznab:attr name="seeders" value="12"/><torznab:attr name="magneturl" value="magnet:?xt=urn:btih:${'b'.repeat(40)}"/></item></channel></rss>`;
  const [it] = parseTorznabResponse(xml);
  assert.equal(it.infohash, 'b'.repeat(40)); assert.equal(it.seeders, 12); assert.equal(it.size, 123); assert.ok(it.magnet);
});

// ---------- end-to-end with a mocked TorBox ----------
test('e2e: ingest → search → resolve → stream (cached, 503 prep, not-cached)', async () => {
  const HASH = 'c'.repeat(40);
  const UNC = 'd'.repeat(40);
  const flacHead = Buffer.alloc(42); flacHead.write('fLaC', 0, 'latin1'); flacHead[4] = 0x80; flacHead[7] = 34;
  { const sr = 96000, bps = 24, total = 96000 * 215; flacHead[18] = sr >> 12; flacHead[19] = (sr >> 4) & 0xff; flacHead[20] = ((sr & 0xf) << 4) | 2 | ((bps - 1) >> 4);
    flacHead[21] = (((bps - 1) & 0xf) << 4); flacHead.writeUInt32BE(total, 22); }
  let finished = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const json = (data: any, status = 200) => new Response(JSON.stringify({ success: status < 400, data, detail: 'x', error: status < 400 ? null : 'ERR' }), { status });
    if (url.includes('/torrents/checkcached')) {
      return json(url.includes(HASH) ? [{ hash: HASH, name: 'Daft Punk - RAM', size: 1, files: [{ name: 'Daft Punk - RAM/01 - Get Lucky.flac', size: 50 }, { name: 'Daft Punk - RAM/cover.jpg', size: 1 }] }] : []);
    }
    if (url.includes('/torrents/createtorrent')) return json({ torrent_id: 77 });
    if (url.includes('/torrents/mylist')) return json({ id: 77, hash: HASH, name: 'x', download_finished: finished, download_present: finished, progress: 0.4,
      files: [{ id: 5, name: 'Daft Punk - RAM/01 - Get Lucky.flac', short_name: '01 - Get Lucky.flac', size: 50 }] });
    if (url.includes('/torrents/requestdl')) { assert.ok(url.includes('redirect=false')); return json('https://cdn.example/get-lucky.flac'); }
    if (url.startsWith('https://cdn.example/')) return new Response(flacHead, { status: 206 });
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const cfg = loadConfig({ DB_PATH: ':memory:', TORBOX_API_KEY: 'server-key' } as any);
    const db = openDb(':memory:');
    const r = await ingestItems(db, cfg, [
      { title: 'Daft Punk - RAM (2013) [FLAC 24bit-96kHz]', infohash: HASH, seeders: 9 },
      { title: 'Other - Thing [FLAC]', infohash: UNC },
    ], 'test');
    assert.equal(r.releases, 2); assert.equal(r.tracks, 1);

    const { app } = await buildApp(db, cfg);
    const manifest = (await app.inject('/manifest.json')).json();
    assert.equal(manifest.id, 'com.custom.losslesscloud'); assert.equal(manifest.settings.length, 3);
    const mres = await app.inject('/manifest.json');
    assert.equal(mres.headers['access-control-allow-origin'], '*');

    const s = (await app.inject('/search?q=get%20lucky')).json();
    assert.equal(s.tracks.length, 1); assert.equal(s.tracks[0].format, 'flac'); assert.equal(s.albums.length, 1);
    const id = s.tracks[0].id;
    assert.equal((await app.inject(`/album/${s.albums[0].id}`)).json().tracks.length, 1);

    // strict resolve: no duration known yet → no match
    assert.equal((await app.inject('/resolve?title=Get%20Lucky&artist=Daft%20Punk&durationMs=215000')).statusCode, 404);

    // not ready → 503 with Retry-After
    const prep = await app.inject(`/stream/${id}`);
    assert.equal(prep.statusCode, 503); assert.equal(prep.headers['retry-after'], '5');
    assert.equal(prep.json().notice.id, `prep-${id}`);

    finished = true;
    const st = await app.inject(`/stream/${id}?torboxKey=user-key`);
    assert.equal(st.statusCode, 200);
    const body = st.json();
    assert.equal(body.url, 'https://cdn.example/get-lucky.flac'); assert.equal(body.bitDepth, 24); assert.equal(body.sampleRate, 96000);
    assert.equal(body.codec, 'flac'); assert.equal(body.encrypted, false); assert.equal(body.manifest, 'none');
    assert.ok(new Date(body.expiresAt).getTime() - Date.now() > 2.9 * 3600_000);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM stream_cache').get() as any).c, 1);

    // duration learned from STREAMINFO → strict resolve now works (±3s) and rejects 10s off
    const ok = await app.inject('/resolve?title=Get%20Lucky%20(Remastered)&artist=Daft%20Punk&durationMs=216500');
    assert.equal(ok.statusCode, 200); assert.equal(ok.json().item.id, id);
    assert.equal((await app.inject('/resolve?title=Get%20Lucky&artist=Daft%20Punk&durationMs=225000')).statusCode, 404);
    assert.equal((await app.inject('/resolve-isrc?isrc=USABC1234567')).statusCode, 404);

    // uncached release + cachedOnly (default) → 404 not_cached, nothing added to TorBox
    db.prepare("UPDATE releases SET files_indexed = 1 WHERE infohash = ?").run(UNC);
    db.prepare("INSERT INTO tracks (release_id,file_path,title,artist,norm_artist,norm_title) SELECT id,'Other - Thing/01 - X.flac','X','Other','other','x' FROM releases WHERE infohash = ?").run(UNC);
    const tid = (db.prepare("SELECT t.id FROM tracks t JOIN releases r ON r.id=t.release_id WHERE r.infohash = ?").get(UNC) as any).id;
    const nc = await app.inject(`/stream/trk-${tid}?torboxKey=user-key`);
    assert.equal(nc.statusCode, 404); assert.equal(nc.json().error, 'not_cached');
    await app.close();
  } finally {
    globalThis.fetch = realFetch;
  }
});
