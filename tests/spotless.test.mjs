import assert from 'node:assert/strict';
import { parseIsoDuration, videosToTracks, createYoutubeApi, MIN_TRACK_MS, MAX_TRACK_MS } from '../frontend/spotless/youtube-api.js';
import { createPlaylistStore, PLAYLISTS_KEY } from '../frontend/spotless/playlists.js';
import { createYoutubeSettings, KEY_STORAGE } from '../frontend/spotless/settings.js';
import { createYoutubePlayback, YT_STATE } from '../frontend/spotless/playback/youtube.js';
import { classifyVideos, SONG_RANGE, searchQuery, durationBuckets, describeSearchOptions, describeShared, exclusions } from '../frontend/spotless/youtube-api.js';
import {
    buildPlaylist, parseLines, songQuery, spotifyTrackId, shuffle, cachedSearch, fetchSpotifyTitle,
    FILLER_QUERY, CACHE_KEY,
} from '../frontend/spotless/build.js';
import {
    parseLabels, normalizeLabels, addLabelCounts, sortedLabels, formatLabelCounts, fetchIssueLabels,
} from '../frontend/spotless/labels.js';

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
    pending.push(async () => {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ✗ ${name}`);
            console.error(`    ${err.message}`);
            failed++;
        }
    });
}

function section(name) {
    pending.push(async () => console.log(`\n${name}`));
}

function fakeStorage() {
    const data = {};
    return {
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        removeItem: (k) => { delete data[k]; },
        data,
    };
}

function video(id, duration, { live = 'none', embeddable = true, title = `Title ${id}` } = {}) {
    return {
        id,
        snippet: { title, channelTitle: `Channel ${id}`, liveBroadcastContent: live },
        contentDetails: { duration },
        status: { embeddable },
    };
}

// --- durations and filtering ---
section('youtube api: parsing');

test('parses ISO 8601 durations', () => {
    assert.equal(parseIsoDuration('PT4M13S'), 253000);
    assert.equal(parseIsoDuration('PT1H2M3S'), 3723000);
    assert.equal(parseIsoDuration('PT45S'), 45000);
    assert.equal(parseIsoDuration('PT10M'), 600000);
    assert.equal(parseIsoDuration('P1DT1S'), 86401000);
});

test('live (P0D) and garbage durations are 0', () => {
    assert.equal(parseIsoDuration('P0D'), 0);
    assert.equal(parseIsoDuration('nonsense'), 0);
    assert.equal(parseIsoDuration(undefined), 0);
});

test('videosToTracks maps to the track shape', () => {
    assert.deepEqual(videosToTracks([video('abc', 'PT3M')]), [
        { id: 'abc', name: 'Title abc', artist: 'Channel abc', duration_ms: 180000 },
    ]);
});

test('videosToTracks drops live, unembeddable, too short and too long videos', () => {
    const tracks = videosToTracks([
        video('ok', 'PT3M'),
        video('live', 'P0D', { live: 'live' }),
        video('upcoming', 'PT3M', { live: 'upcoming' }),
        video('blocked', 'PT3M', { embeddable: false }),
        video('short', 'PT30S'),
        video('mix', 'PT2H'),
    ]);
    assert.deepEqual(tracks.map(t => t.id), ['ok']);
});

test('duration bounds are inclusive', () => {
    const tracks = videosToTracks([video('min', 'PT1M'), video('max', 'PT20M')]);
    assert.equal(MIN_TRACK_MS, 60000);
    assert.equal(MAX_TRACK_MS, 1200000);
    assert.deepEqual(tracks.map(t => t.id), ['min', 'max']);
});

// --- api with fake fetch ---
section('youtube api: requests');

function fakeFetch(handler) {
    const calls = [];
    const fn = async (url) => {
        const u = new URL(url);
        calls.push(u);
        const { status = 200, body } = handler(u);
        return { ok: status < 400, status, json: async () => body };
    };
    fn.calls = calls;
    return fn;
}

function searchFetch(idsFor) {
    return fakeFetch((u) => u.pathname.endsWith('/search')
        ? { body: { items: idsFor(u).map(id => ({ id: { videoId: id } })) } }
        : { body: { items: u.searchParams.get('id').split(',').map(id => video(id, 'PT3M')) } });
}

const idList = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test('first pass: Music, short bucket, with the key, embeddable and SafeSearch; stops when enough', async () => {
    const fetchFn = searchFetch(() => idList('a', 20));
    const tracks = await createYoutubeApi(() => 'KEY', fetchFn).searchTracks('lofi beats');
    assert.equal(tracks.length, 20);
    const search = fetchFn.calls[0];
    assert.equal(search.searchParams.get('key'), 'KEY');
    assert.equal(search.searchParams.get('q'), 'lofi beats -live -cover -remix');  // live and covers off by default
    assert.equal(search.searchParams.get('type'), 'video');
    assert.equal(search.searchParams.get('videoEmbeddable'), 'true');
    assert.equal(search.searchParams.get('videoCategoryId'), '10');
    assert.equal(search.searchParams.get('videoDuration'), 'short');
    assert.equal(search.searchParams.get('safeSearch'), 'none');  // Allow explicit is on by default
    assert.equal(fetchFn.calls[1].searchParams.get('id'), idList('a', 20).join(','));
    assert.equal(fetchFn.calls.length, 2);  // 101 quota units
});

test('too few: each bucket in Music, then outside it, without duplicates', async () => {
    const fetchFn = searchFetch((u) => {
        const p = u.searchParams;
        if (!p.has('videoCategoryId')) return ['c', 'b'];
        return p.get('videoDuration') === 'short' ? ['a0'] : ['b', 'a0'];
    });
    const tracks = await createYoutubeApi(() => 'KEY', fetchFn).searchTracks('rain sounds');
    assert.deepEqual(tracks.map(t => t.id), ['a0', 'b', 'c']);
    const searches = fetchFn.calls.filter(u => u.pathname.endsWith('/search')).map(u => u.searchParams);
    assert.deepEqual(searches.map(p => [p.get('videoCategoryId'), p.get('videoDuration')]),
        [['10', 'short'], ['10', 'medium'], [null, 'short'], [null, 'medium']]);
});

test('options: search words, SafeSearch, and the exact length range', async () => {
    let seenQ = null;
    let seenSafe = null;
    const fetchFn = fakeFetch((u) => {
        if (u.pathname.endsWith('/search')) {
            seenQ = u.searchParams.get('q');
            seenSafe = u.searchParams.get('safeSearch');
            return { body: { items: ['short', 'ok', 'long'].map(id => ({ id: { videoId: id } })) } };
        }
        const len = { short: 'PT2M', ok: 'PT6M', long: 'PT9M' };
        return { body: { items: u.searchParams.get('id').split(',').map(id => video(id, len[id])) } };
    });
    const tracks = await createYoutubeApi(() => 'KEY', fetchFn).searchTracks('jazz', {
        minMinutes: 5, maxMinutes: 8, instrumental: true, explicit: false, official: true, live: true, covers: true,
    });
    assert.equal(seenQ, 'jazz instrumental "official audio"');
    assert.equal(seenSafe, 'moderate');
    assert.deepEqual(tracks.map(t => t.id), ['ok']);
});

test('durationBuckets picks the YouTube length buckets a range needs', () => {
    const m = 60000;
    assert.deepEqual(durationBuckets(2 * m, 5 * m), ['short', 'medium']);
    assert.deepEqual(durationBuckets(1 * m, 4 * m), ['short']);
    assert.deepEqual(durationBuckets(4 * m, 10 * m), ['medium']);
});

test('searchQuery excludes live and covers by default, but not words the text contains', () => {
    assert.equal(searchQuery('  lofi  '), 'lofi -live -cover -remix');
    assert.equal(searchQuery('Oasis - Live Forever'), 'Oasis - Live Forever -cover -remix');
    assert.equal(searchQuery('lofi', { live: true, covers: true }), 'lofi');
    assert.deepEqual(exclusions('Song (Remix)', { live: true }), ['-cover']);
});

test('describeSearchOptions says only what differs from the defaults', () => {
    assert.equal(describeSearchOptions(), '2–5 min');
    assert.equal(describeSearchOptions({ instrumental: true, explicit: false, live: true, official: true }),
        '2–5 min · instrumental · no explicit · official audio · with live');
    assert.deepEqual(describeShared({ covers: true }), ['with covers']);
});

test('API errors surface the message and reason', async () => {
    const fetchFn = fakeFetch(() => ({
        status: 403,
        body: { error: { message: 'Quota exceeded', errors: [{ reason: 'quotaExceeded' }] } },
    }));
    await assert.rejects(createYoutubeApi(() => 'KEY', fetchFn).searchTracks('x'),
        (err) => err.reason === 'quotaExceeded' && /Quota exceeded/.test(err.message));
});

// --- playlist store ---
section('playlist store');

function store(storage = fakeStorage()) {
    let t = 1000;
    let n = 0;
    return createPlaylistStore({ storage, now: () => t++, newId: () => `p${++n}` });
}

const TRACKS = [
    { id: 'a', name: 'A', artist: 'X', duration_ms: 180000 },
    { id: 'b', name: 'B', artist: 'Y', duration_ms: 200000 },
];

test('save then get round-trips', () => {
    const s = store();
    const p = s.save({ name: 'Focus', query: 'lofi', minutes: 25, tracks: TRACKS });
    assert.deepEqual(s.get(p.id), { id: 'p1', name: 'Focus', query: 'lofi', minutes: 25, createdAt: 1000, tracks: TRACKS });
});

test('persists as JSON under spotless_playlists', () => {
    const storage = fakeStorage();
    store(storage).save({ name: 'Focus', tracks: TRACKS });
    assert.equal(JSON.parse(storage.data[PLAYLISTS_KEY])[0].name, 'Focus');
    assert.deepEqual(Object.keys(storage.data), [PLAYLISTS_KEY]);
});

test('list is newest first', () => {
    const s = store();
    s.save({ name: 'one', tracks: TRACKS });
    s.save({ name: 'two', tracks: TRACKS });
    assert.deepEqual(s.list().map(p => p.name), ['two', 'one']);
});

test('blank name falls back to the query', () => {
    assert.equal(store().save({ name: '  ', query: 'lofi', tracks: TRACKS }).name, 'lofi');
});

test('saving with no tracks throws', () => {
    assert.throws(() => store().save({ name: 'x', tracks: [] }));
});

test('extra track fields are dropped', () => {
    const p = store().save({ name: 'x', tracks: [{ ...TRACKS[0], junk: 1 }] });
    assert.deepEqual(p.tracks, [TRACKS[0]]);
});

test('save keeps how the playlist was made', () => {
    const source = { kind: 'search', query: 'lofi', options: { minMinutes: 2, maxMinutes: 5 } };
    const p = store().save({ name: 'x', query: 'lofi', tracks: TRACKS, source });
    assert.deepEqual(p.source, source);
    assert.equal('source' in store().save({ name: 'y', tracks: TRACKS }), false);
});

test('rename and remove', () => {
    const s = store();
    const p = s.save({ name: 'old', tracks: TRACKS });
    s.rename(p.id, '  new ');
    assert.equal(s.get(p.id).name, 'new');
    s.rename(p.id, '');
    assert.equal(s.get(p.id).name, 'new');
    s.remove(p.id);
    assert.equal(s.get(p.id), null);
});

test('corrupt storage reads as empty; invalid entries are skipped', () => {
    const storage = fakeStorage();
    storage.setItem(PLAYLISTS_KEY, '{nope');
    assert.deepEqual(store(storage).list(), []);
    storage.setItem(PLAYLISTS_KEY, JSON.stringify([{ id: 'x', name: 'bad', tracks: [] }]));
    assert.deepEqual(store(storage).list(), []);
});

test('export then import into another browser', () => {
    const a = store();
    a.save({ name: 'Focus', tracks: TRACKS });
    const b = store();
    assert.equal(b.importJson(a.exportJson()), 1);
    assert.deepEqual(b.list(), a.list());
});

test('import skips playlists already present and invalid ones', () => {
    const s = store();
    s.save({ name: 'Focus', tracks: TRACKS });
    const text = JSON.stringify([...s.list(), { id: 'bad', name: 'no tracks', tracks: [] },
        { id: 'new', name: 'New', createdAt: 5, tracks: TRACKS }]);
    assert.equal(s.importJson(text), 1);
    assert.deepEqual(s.list().map(p => p.id).sort(), ['new', 'p1']);
});

test('import rejects a file with no playlists', () => {
    assert.throws(() => store().importJson('{"hello":1}'), /No playlists/);
});

// --- settings ---
section('youtube key settings');

test('pasted key overrides the built-in key; clearing falls back', () => {
    const storage = fakeStorage();
    const settings = createYoutubeSettings(storage, 'BUILTIN');
    assert.equal(settings.getKey(), 'BUILTIN');
    assert.equal(settings.hasPastedKey(), false);
    settings.setKey('  MINE ');
    assert.equal(settings.getKey(), 'MINE');
    assert.equal(storage.data[KEY_STORAGE], 'MINE');
    settings.clearKey();
    assert.equal(settings.getKey(), 'BUILTIN');
});

test('no key at all is empty', () => {
    assert.equal(createYoutubeSettings(fakeStorage(), '').getKey(), '');
});

// --- playback adapter ---
section('youtube playback adapter');

function fakeYT({ ready = true } = {}) {
    const yt = { players: [] };
    yt.Player = class {
        constructor(element, options) {
            this.element = element;
            this.options = options;
            this.loaded = [];
            this.calls = [];
            yt.players.push(this);
            if (ready) queueMicrotask(() => options.events.onReady({ target: this }));
        }
        loadVideoById(id) { this.loaded.push(id); this.calls.push(['load', id]); }
        pauseVideo() { this.calls.push(['pause']); }
        playVideo() { this.calls.push(['play']); }
        stopVideo() { this.calls.push(['stop']); }
        seekTo(s) { this.calls.push(['seek', s]); }
        getCurrentTime() { return this.time ?? 0; }
        fire(data) { this.options.events.onStateChange({ data }); }
        error(data) { this.options.events.onError({ data }); }
    };
    return yt;
}

const LIST = [
    { id: 'v1', duration_ms: 1000 },
    { id: 'v2', duration_ms: 1000 },
    { id: 'v3', duration_ms: 1000 },
];

async function readyAdapter(yt = fakeYT()) {
    const adapter = createYoutubePlayback({ element: 'player', loadApi: async () => yt });
    const changes = [];
    adapter.onStateChange(c => changes.push(c));
    await adapter.init();
    return { adapter, player: yt.players[0], changes };
}

test('init resolves once the player is ready', async () => {
    const { player } = await readyAdapter();
    assert.equal(player.element, 'player');
    assert.ok(player.options.width >= 200 && player.options.height >= 200);
});

test('init rejects if the player never becomes ready', async () => {
    const adapter = createYoutubePlayback({ element: 'p', loadApi: async () => fakeYT({ ready: false }), readyTimeoutMs: 5 });
    await assert.rejects(adapter.init(), /did not become ready/);
});

test('play loads the first video synchronously (inside the click)', async () => {
    const { adapter, player } = await readyAdapter();
    adapter.play(LIST);  // not awaited: the load must already have happened
    assert.deepEqual(player.loaded, ['v1']);
});

test('playing / paused map to changes; duplicates are dropped', async () => {
    const { adapter, player, changes } = await readyAdapter();
    await adapter.play(LIST);
    player.fire(YT_STATE.BUFFERING);
    player.fire(YT_STATE.PLAYING);
    player.fire(YT_STATE.PLAYING);
    player.fire(YT_STATE.PAUSED);
    assert.deepEqual(changes, [
        { playing: false, trackIndex: 0, ended: false },
        { playing: true, trackIndex: 0, ended: false },
        { playing: false, trackIndex: 0, ended: false },
    ]);
});

test('each ended video loads the next; the last one ends the session', async () => {
    const { adapter, player, changes } = await readyAdapter();
    await adapter.play(LIST);
    for (let i = 0; i < 3; i++) {
        player.fire(YT_STATE.PLAYING);
        player.fire(YT_STATE.ENDED);
    }
    assert.deepEqual(player.loaded, ['v1', 'v2', 'v3']);
    assert.deepEqual(changes.at(-1), { playing: false, trackIndex: 2, ended: true });
    assert.equal(changes.filter(c => c.ended).length, 1);
});

test('a video that errors (e.g. embedding blocked) is skipped', async () => {
    const { adapter, player, changes } = await readyAdapter();
    const warn = console.warn;
    console.warn = () => {};
    try {
        await adapter.play(LIST);
        player.error(150);
        assert.deepEqual(player.loaded, ['v1', 'v2']);
        assert.equal(changes.at(-1).trackIndex, 1);
        player.error(101);
        player.error(100);
        assert.deepEqual(changes.at(-1), { playing: false, trackIndex: 2, ended: true });
    } finally {
        console.warn = warn;
    }
});

test('states after the end or after stop are ignored', async () => {
    const { adapter, player, changes } = await readyAdapter();
    await adapter.play(LIST);
    await adapter.stop();
    assert.deepEqual(player.calls.at(-1), ['stop']);
    const count = changes.length;
    player.fire(YT_STATE.PLAYING);
    player.fire(YT_STATE.ENDED);
    assert.equal(changes.length, count);
    assert.deepEqual(player.loaded, ['v1']);
});

test('pause and resume call the player', async () => {
    const { adapter, player } = await readyAdapter();
    await adapter.play(LIST);
    await adapter.pause();
    await adapter.resume();
    assert.deepEqual(player.calls.slice(-2), [['pause'], ['play']]);
});

test('next skips to the next track; past the last it ends the session', async () => {
    const { adapter, player, changes } = await readyAdapter();
    await adapter.play(LIST);
    await adapter.next();
    assert.deepEqual(player.loaded, ['v1', 'v2']);
    assert.equal(changes.at(-1).trackIndex, 1);
    await adapter.next();
    await adapter.next();
    assert.deepEqual(changes.at(-1), { playing: false, trackIndex: 2, ended: true });
});

test('previous restarts the track after 3 s, else goes back one', async () => {
    const { adapter, player, changes } = await readyAdapter();
    await adapter.play(LIST);
    await adapter.previous();                 // first track: restart
    assert.deepEqual(player.calls.at(-1), ['seek', 0]);
    await adapter.next();
    player.time = 10;
    await adapter.previous();                 // 10 s in: restart
    assert.deepEqual(player.calls.at(-1), ['seek', 0]);
    assert.deepEqual(player.loaded, ['v1', 'v2']);
    player.time = 1;
    await adapter.previous();                 // just started: back to v1
    assert.deepEqual(player.loaded, ['v1', 'v2', 'v1']);
    assert.equal(changes.at(-1).trackIndex, 0);
});

test('next and previous do nothing when no session is playing', async () => {
    const { adapter, player } = await readyAdapter();
    await adapter.next();
    await adapter.previous();
    assert.deepEqual(player.calls, []);
});

test('a second play starts the new list from the top', async () => {
    const { adapter, player, changes } = await readyAdapter();
    await adapter.play(LIST);
    player.fire(YT_STATE.ENDED);
    await adapter.play([{ id: 'w1', duration_ms: 1 }]);
    assert.deepEqual(player.loaded, ['v1', 'v2', 'w1']);
    assert.deepEqual(changes.at(-1), { playing: false, trackIndex: 0, ended: false });
});


// --- build from a list ---
section('build: parsing');

const ALL = { live: true, covers: true };  // no exclusions: queries stay '<line> audio'

test('parseLines trims, drops blanks, list markers and repeats', () => {
    assert.deepEqual(parseLines('  Johnny Cash - Hurt \n\n1. Song A\n2) Song B\n- Song C\n* song a\n•  Song   D\r\nhurt'),
        ['Johnny Cash - Hurt', 'Song A', 'Song B', 'Song C', 'Song D', 'hurt']);
});

test('parseLines keeps a leading number that is part of the name', () => {
    assert.deepEqual(parseLines('99 Luftballons\n1979'), ['99 Luftballons', '1979']);
});

test('songQuery adds " audio" once, drops quotes, and excludes live and covers by default', () => {
    assert.equal(songQuery('Johnny Cash - "Hurt"'), 'Johnny Cash - Hurt audio -live -cover -remix');
    assert.equal(songQuery('Hurt (audio)', ALL), 'Hurt (audio)');
    assert.equal(songQuery('Hurt', { ...ALL, official: true }), 'Hurt "official audio"');
    assert.equal(songQuery('Oasis - Live Forever'), 'Oasis - Live Forever audio -cover -remix');
});

test('spotifyTrackId recognizes track links and URIs', () => {
    const id = '4cOdK2wGLETKBW3PvgPWqT';
    assert.equal(spotifyTrackId(`https://open.spotify.com/track/${id}`), id);
    assert.equal(spotifyTrackId(`https://open.spotify.com/track/${id}?si=abc123`), id);
    assert.equal(spotifyTrackId(`https://open.spotify.com/intl-de/track/${id}`), id);
    assert.equal(spotifyTrackId(`spotify:track:${id}`), id);
    assert.equal(spotifyTrackId(`https://open.spotify.com/album/${id}`), null);
    assert.equal(spotifyTrackId('Johnny Cash - Hurt'), null);
});

test('shuffle is a permutation', () => {
    assert.deepEqual(shuffle([1, 2, 3, 4], () => 0.3).sort(), [1, 2, 3, 4]);
});

test('classifyVideos explains rejections', () => {
    const out = classifyVideos([
        video('ok', 'PT3M'), video('live', 'P0D', { live: 'live' }),
        video('blocked', 'PT3M', { embeddable: false }), video('album', 'PT40M'),
    ], SONG_RANGE);
    assert.equal(out[0].track.id, 'ok');
    assert.deepEqual(out.slice(1).map(r => r.reason), ['live stream', 'not embeddable', '40:00, outside 1:00–12:00']);
});

section('build: algorithm');

const MIN = 60000;
const t = (id, min = 5) => ({ id, name: `Song ${id}`, artist: 'A', duration_ms: min * MIN });
const ok = (...tracks) => ({ results: tracks.map(track => ({ track })) });
const noShuffle = () => 0.999;  // shuffle() with random ~1 keeps the order

function fakeSearch(table) {
    const calls = [];
    const fn = async (query) => {
        calls.push(query);
        if (!(query in table)) return { results: [] };
        const v = table[query];
        if (v instanceof Error) throw v;
        return v;
    };
    fn.calls = calls;
    return fn;
}

test('takes the first usable result per line and stops searching once full', async () => {
    const search = fakeSearch({
        'a audio': ok(t('a1'), t('a2')),
        'b audio': { results: [{ id: 'x', name: 'Live!', reason: 'live stream' }, { track: t('b1') }] },
        'c audio': ok(t('c1')),
        'd audio': ok(t('d1')),
    });
    const { tracks, log } = await buildPlaylist({ options: ALL, lines: ['a', 'b', 'c', 'd'], minutes: 10, searchSong: search, random: noShuffle });
    assert.deepEqual(tracks.map(x => x.id), ['a1', 'b1']);
    assert.deepEqual(search.calls, ['a audio', 'b audio']);
    assert.deepEqual(log[1].rejected, [{ name: 'Live!', reason: 'live stream' }]);
    assert.deepEqual(log.at(-1), { kind: 'unused', count: 2, lines: ['c', 'd'] });
});

test('adds one track over the limit, like selectTracksForDuration', async () => {
    const search = fakeSearch({ 'a audio': ok(t('a', 4)), 'b audio': ok(t('b', 4)), 'c audio': ok(t('c', 4)) });
    const { tracks } = await buildPlaylist({ options: ALL, lines: ['a', 'b', 'c'], minutes: 6, searchSong: search, random: noShuffle });
    assert.deepEqual(tracks.map(x => x.id), ['a', 'b']);
});

test('a line with nothing usable is skipped', async () => {
    const search = fakeSearch({ 'b audio': ok(t('b', 30)) });
    const { tracks, log } = await buildPlaylist({ options: ALL, lines: ['a', 'b'], minutes: 25, searchSong: search, random: noShuffle });
    assert.deepEqual(tracks.map(x => x.id), ['b']);
    assert.equal(log[0].pick, null);
});

test('the same video is not picked twice', async () => {
    const search = fakeSearch({ 'a audio': ok(t('same')), 'a again audio': ok(t('same'), t('other')) });
    const { tracks, log } = await buildPlaylist({ options: ALL, lines: ['a', 'a again'], minutes: 60, searchSong: search, random: noShuffle });
    assert.deepEqual(tracks.slice(0, 2).map(x => x.id), ['same', 'other']);
    assert.equal(log[1].rejected[0].reason, 'already in the playlist');
});

test('short pool: fills from other results, then bluegrass', async () => {
    const search = fakeSearch({
        'a audio': ok(t('a1'), t('a2')),
        [FILLER_QUERY]: ok(t('g1'), t('g2'), t('g3'), t('g4')),
    });
    const { tracks, log } = await buildPlaylist({ options: ALL, lines: ['a'], minutes: 20, searchSong: search, random: noShuffle });
    assert.deepEqual(tracks.map(x => x.id), ['a1', 'a2', 'g1', 'g2']);
    assert.deepEqual(log.map(e => e.source ?? e.kind), ['line', 'results', 'bluegrass']);
    assert.deepEqual(search.calls, ['a audio', FILLER_QUERY]);
});

test('no bluegrass search when other results are enough', async () => {
    const search = fakeSearch({ 'a audio': ok(t('a1'), t('a2'), t('a3')) });
    const { tracks, log } = await buildPlaylist({ options: ALL, lines: ['a'], minutes: 12, searchSong: search, random: noShuffle });
    assert.deepEqual(tracks.map(x => x.id), ['a1', 'a2', 'a3']);
    assert.equal(log.some(e => e.source === 'bluegrass'), false);
});

test('Spotify links are looked up, then searched by title', async () => {
    const id = '4cOdK2wGLETKBW3PvgPWqT';
    const search = fakeSearch({ 'Hurt audio': ok(t('h', 30), t('h2')) });
    const { log } = await buildPlaylist({
        options: ALL,
        lines: [`https://open.spotify.com/track/${id}?si=x`], minutes: 3, searchSong: search,
        spotifyTitle: async (got) => { assert.equal(got, id); return 'Hurt'; }, random: noShuffle,
    });
    assert.equal(log[0].spotify, 'Hurt');
    assert.equal(log[0].query, 'Hurt audio');
});

test('a failed Spotify lookup or search skips just that line', async () => {
    const id = '4cOdK2wGLETKBW3PvgPWqT';
    const search = fakeSearch({ 'bad audio': new Error('boom'), 'good audio': ok(t('g')) });
    const { tracks, log } = await buildPlaylist({
        options: ALL,
        lines: [`spotify:track:${id}`, 'bad', 'good'], minutes: 3, searchSong: search,
        spotifyTitle: async () => { throw new Error('Spotify lookup failed (404)'); }, random: noShuffle,
    });
    assert.deepEqual(tracks.map(x => x.id), ['g']);
    assert.deepEqual(log.slice(0, 2).map(e => e.error), ['Spotify lookup failed (404)', 'boom']);
});

test('running out of quota stops the build', async () => {
    const quota = Object.assign(new Error('quota'), { reason: 'quotaExceeded' });
    const search = fakeSearch({ 'a audio': quota });
    await assert.rejects(buildPlaylist({ options: ALL, lines: ['a', 'b'], minutes: 25, searchSong: search, random: noShuffle }), /quota/);
});

test('lines are tried in random order', async () => {
    const search = fakeSearch({ 'a audio': ok(t('a')), 'b audio': ok(t('b')) });
    const { tracks } = await buildPlaylist({ options: ALL, lines: ['a', 'b'], minutes: 3, searchSong: search, random: () => 0 });
    assert.deepEqual(tracks.map(x => x.id), ['b']);
});

test('the Live / Covers / Official row shapes every line query', async () => {
    const search = fakeSearch({});
    await buildPlaylist({ lines: ['a'], minutes: 3, searchSong: search, random: noShuffle, options: { official: true } });
    assert.equal(search.calls[0], 'a "official audio" -live -cover -remix');
});

test('onLog is called live for each entry', async () => {
    const seen = [];
    await buildPlaylist({ options: ALL, lines: ['a', 'b'], minutes: 3, searchSong: fakeSearch({ 'a audio': ok(t('a')) }),
        random: noShuffle, onLog: (e) => seen.push(e.kind) });
    assert.deepEqual(seen, ['line', 'unused']);
});

section('build: search cache and Spotify lookup');

test('cache answers a repeat query without searching', async () => {
    const storage = fakeStorage();
    const search = fakeSearch({ 'a audio': ok(t('a')) });
    const cached = cachedSearch(search, { storage });
    assert.equal((await cached('a audio')).cached, false);
    const again = await cached('A Audio');
    assert.equal(again.cached, true);
    assert.equal(again.results[0].track.id, 'a');
    assert.equal(search.calls.length, 1);
    assert.ok(storage.data[CACHE_KEY]);
});

test('cache expires old entries and keeps only the newest', async () => {
    let now = 0;
    const search = fakeSearch({});
    const cached = cachedSearch(search, { storage: fakeStorage(), now: () => now, max: 2, maxAgeMs: 100 });
    await cached('q1'); now = 1; await cached('q2'); now = 2; await cached('q3');
    now = 3; await cached('q1');           // evicted (max 2), searched again
    now = 500; await cached('q3');         // expired, searched again
    assert.deepEqual(search.calls, ['q1', 'q2', 'q3', 'q1', 'q3']);
});

test('fetchSpotifyTitle reads the oEmbed title', async () => {
    let asked = '';
    const title = await fetchSpotifyTitle('ID', async (url) => { asked = url; return { ok: true, json: async () => ({ title: 'Hurt' }) }; });
    assert.equal(title, 'Hurt');
    assert.match(asked, /^https:\/\/open\.spotify\.com\/oembed\?url=https%3A%2F%2Fopen\.spotify\.com%2Ftrack%2FID$/);
    await assert.rejects(fetchSpotifyTitle('ID', async () => ({ ok: false, status: 404 })), /404/);
});

test('searchSong tries Music, then all of YouTube when nothing is usable', async () => {
    const fetchFn = searchFetch((u) => (u.searchParams.has('videoCategoryId') ? ['long'] : ['good']));
    const real = fetchFn;
    const wrapped = async (url) => {
        const res = await real(url);
        const u = new URL(url);
        if (u.pathname.endsWith('/videos')) {
            const ids = u.searchParams.get('id').split(',');
            return { ok: true, status: 200, json: async () => ({ items: ids.map(id => video(id, id === 'long' ? 'PT40M' : 'PT3M')) }) };
        }
        return res;
    };
    const { results, passes } = await createYoutubeApi(() => 'KEY', wrapped).searchSong('hurt audio');
    assert.equal(passes, 2);
    assert.deepEqual(results.map(r => r.track?.id ?? `x:${r.id}`), ['x:long', 'good']);
});

// --- labels ---
section('labels');

test('parseLabels splits on commas, trims, drops blanks and repeats in any case', () => {
    assert.deepEqual(parseLabels(' writing, Planning ,, planning,  deep   work '), ['writing', 'Planning', 'deep work']);
    assert.deepEqual(parseLabels(''), []);
});

test("Pomodorify's own label is ignored", () => {
    assert.deepEqual(normalizeLabels(['bug', 'Pomodorify Created']), ['bug']);
});

test('addLabelCounts adds new labels and increments existing ones (any case)', () => {
    let counts = addLabelCounts(undefined, ['bug', 'ui']);
    counts = addLabelCounts(counts, ['Bug', 'docs']);
    assert.deepEqual(counts, { bug: 2, ui: 1, docs: 1 });
});

test('a label repeated in one session counts once', () => {
    assert.deepEqual(addLabelCounts({}, ['bug', 'BUG']), { bug: 1 });
});

test('addLabelCounts does not change its input', () => {
    const counts = { bug: 1 };
    addLabelCounts(counts, ['bug']);
    assert.deepEqual(counts, { bug: 1 });
});

test('sorted most used first, then by name', () => {
    assert.deepEqual(sortedLabels({ ui: 1, bug: 3, Alpha: 1 }).map(([n]) => n), ['bug', 'Alpha', 'ui']);
    assert.equal(formatLabelCounts({ ui: 1, bug: 3 }), 'bug ×3, ui ×1');
    assert.equal(formatLabelCounts(undefined), '');
});

test('fetchIssueLabels reads label names through the GitHub api object', async () => {
    let asked = null;
    const api = { graphql: async (query, vars) => {
        asked = { query, vars };
        return { node: { labels: { nodes: [{ name: 'bug' }, { name: 'pomodorify created' }, { name: 'ui' }] } } };
    } };
    assert.deepEqual(await fetchIssueLabels(api, 'I_1'), ['bug', 'ui']);
    assert.deepEqual(asked.vars, { id: 'I_1' });
    assert.match(asked.query, /labels\(first: 50\)/);
});

test('playlist store counts labels per playlist, and they survive export/import', () => {
    const s = store();
    const a = s.save({ name: 'A', tracks: TRACKS });
    const b = s.save({ name: 'B', tracks: TRACKS });
    s.addLabels(a.id, ['bug', 'ui']);
    assert.deepEqual(s.addLabels(a.id, ['bug']), { bug: 2, ui: 1 });
    assert.deepEqual(s.get(a.id).labels, { bug: 2, ui: 1 });
    assert.equal(s.get(b.id).labels, undefined);
    const other = store();
    other.importJson(s.exportJson());
    assert.deepEqual(other.get(a.id).labels, { bug: 2, ui: 1 });
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
