import assert from 'node:assert/strict';
import { parseIsoDuration, videosToTracks, createYoutubeApi, MIN_TRACK_MS, MAX_TRACK_MS } from '../frontend/spotless/youtube-api.js';
import { createPlaylistStore, PLAYLISTS_KEY } from '../frontend/spotless/playlists.js';
import { createYoutubeSettings, KEY_STORAGE } from '../frontend/spotless/settings.js';
import { createYoutubePlayback, YT_STATE } from '../frontend/spotless/playback/youtube.js';

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

test('first pass: 4-20 min Music videos with the key and embeddable filters; stops when enough', async () => {
    const fetchFn = searchFetch(() => idList('a', 20));
    const tracks = await createYoutubeApi(() => 'KEY', fetchFn).searchTracks('lofi beats');
    assert.equal(tracks.length, 20);
    const search = fetchFn.calls[0];
    assert.equal(search.searchParams.get('key'), 'KEY');
    assert.equal(search.searchParams.get('q'), 'lofi beats');
    assert.equal(search.searchParams.get('type'), 'video');
    assert.equal(search.searchParams.get('videoEmbeddable'), 'true');
    assert.equal(search.searchParams.get('videoCategoryId'), '10');
    assert.equal(search.searchParams.get('videoDuration'), 'medium');
    assert.equal(fetchFn.calls[1].searchParams.get('id'), idList('a', 20).join(','));
    assert.equal(fetchFn.calls.length, 2);  // 101 quota units
});

test('too few: adds short Music, then medium of any category, without duplicates', async () => {
    const fetchFn = searchFetch((u) => {
        const p = u.searchParams;
        if (p.get('videoDuration') === 'short') return ['b', 'a0'];
        return p.has('videoCategoryId') ? ['a0'] : ['c', 'b'];
    });
    const tracks = await createYoutubeApi(() => 'KEY', fetchFn).searchTracks('rain sounds');
    assert.deepEqual(tracks.map(t => t.id), ['a0', 'b', 'c']);
    const searches = fetchFn.calls.filter(u => u.pathname.endsWith('/search')).map(u => u.searchParams);
    assert.deepEqual(searches.map(p => [p.get('videoCategoryId'), p.get('videoDuration')]),
        [['10', 'medium'], ['10', 'short'], [null, 'medium']]);
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

test('a second play starts the new list from the top', async () => {
    const { adapter, player, changes } = await readyAdapter();
    await adapter.play(LIST);
    player.fire(YT_STATE.ENDED);
    await adapter.play([{ id: 'w1', duration_ms: 1 }]);
    assert.deepEqual(player.loaded, ['v1', 'v2', 'w1']);
    assert.deepEqual(changes.at(-1), { playing: false, trackIndex: 0, ended: false });
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
