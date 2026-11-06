import assert from 'node:assert/strict';
import { createLocalLogger } from '../frontend/track/loggers/local.js';
import { createSessionClock, createSession, formatClock, remainingMs } from '../frontend/track/session.js';
import { createAuth, hasScopes, SCOPES, STORAGE_KEYS } from '../frontend/track/auth.js';
import { currentTrackUri, initialTracker, nextTrackerState } from '../frontend/track/playback/spotify-state.js';
import { createSpotifyPlayback } from '../frontend/track/playback/spotify.js';
import { totalsToCsv, totalsToJson, describeTotals } from '../frontend/track/export.js';
import { partitionPlaylists, orderReplays } from '../frontend/track/playlists.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        failed++;
    }
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

// A clock we move by hand.
function fakeNow(start = 0) {
    let t = start;
    const now = () => t;
    now.advance = (ms) => { t += ms; };
    return now;
}

// --- local logger ---
console.log('\nlocal logger');

test('adds to totals across calls', () => {
    const logger = createLocalLogger(fakeStorage());
    logger.addHours('Atlas', 1.5);
    logger.addHours('Atlas', 0.25);
    assert.deepEqual(logger.getTotals(), { Atlas: 1.75 });
});

test('new projects appear in getTotals', () => {
    const logger = createLocalLogger(fakeStorage());
    logger.addHours('Atlas', 1);
    logger.addHours('Board game', 2);
    assert.deepEqual(Object.keys(logger.getTotals()).sort(), ['Atlas', 'Board game']);
});

test('clear empties everything', () => {
    const storage = fakeStorage();
    const logger = createLocalLogger(storage);
    logger.addHours('Atlas', 1);
    logger.clear();
    assert.deepEqual(logger.getTotals(), {});
    assert.deepEqual(storage.data, {});
});

test('persists through storage (a new logger sees old totals)', () => {
    const storage = fakeStorage();
    createLocalLogger(storage).addHours('Atlas', 1);
    assert.deepEqual(createLocalLogger(storage).getTotals(), { Atlas: 1 });
});

test('ignores blank project names and non-positive hours', () => {
    const logger = createLocalLogger(fakeStorage());
    logger.addHours('', 1);
    logger.addHours('   ', 1);
    logger.addHours('Atlas', 0);
    logger.addHours('Atlas', -1);
    assert.deepEqual(logger.getTotals(), {});
});

test('trims project names', () => {
    const logger = createLocalLogger(fakeStorage());
    logger.addHours(' Atlas ', 1);
    logger.addHours('Atlas', 1);
    assert.deepEqual(logger.getTotals(), { Atlas: 2 });
});

test('treats corrupt stored data as empty', () => {
    const storage = fakeStorage();
    storage.setItem('pomodorify_hours', '{not json');
    assert.deepEqual(createLocalLogger(storage).getTotals(), {});
});

// --- session clock ---
console.log('\nsession clock');

test('starts at zero and only counts while playing', () => {
    const now = fakeNow();
    const clock = createSessionClock(now);
    now.advance(5000);
    assert.equal(clock.elapsedMs(), 0);
    clock.setPlaying(true);
    now.advance(3000);
    assert.equal(clock.elapsedMs(), 3000);
});

test('pause stops the clock, resume continues it', () => {
    const now = fakeNow();
    const clock = createSessionClock(now);
    clock.setPlaying(true);
    now.advance(1000);
    clock.setPlaying(false);
    now.advance(60000);
    clock.setPlaying(true);
    now.advance(2000);
    assert.equal(clock.elapsedMs(), 3000);
});

test('repeated playing reports do not restart or double count', () => {
    const now = fakeNow();
    const clock = createSessionClock(now);
    clock.setPlaying(true);
    now.advance(1000);
    clock.setPlaying(true);
    clock.setPlaying(true);
    now.advance(1000);
    assert.equal(clock.elapsedMs(), 2000);
});

test('repeated paused reports do not change the total', () => {
    const now = fakeNow();
    const clock = createSessionClock(now);
    clock.setPlaying(true);
    now.advance(1000);
    clock.setPlaying(false);
    clock.setPlaying(false);
    now.advance(1000);
    assert.equal(clock.elapsedMs(), 1000);
});

// --- session ---
console.log('\nsession');

test('finish logs elapsed hours to the project', () => {
    const now = fakeNow();
    const logger = createLocalLogger(fakeStorage());
    const session = createSession({ project: 'Atlas', logger, now });
    session.setPlaying(true);
    now.advance(30 * 60000);
    assert.equal(session.finish(), 0.5);
    assert.deepEqual(logger.getTotals(), { Atlas: 0.5 });
});

test('finish twice logs once (Stop then pagehide)', () => {
    const now = fakeNow();
    const logger = createLocalLogger(fakeStorage());
    const session = createSession({ project: 'Atlas', logger, now });
    session.setPlaying(true);
    now.advance(60 * 60000);
    session.finish();
    now.advance(60 * 60000);
    assert.equal(session.finish(), 0);
    assert.deepEqual(logger.getTotals(), { Atlas: 1 });
});

test('blank project logs nothing', () => {
    const now = fakeNow();
    const logger = createLocalLogger(fakeStorage());
    const session = createSession({ project: '  ', logger, now });
    session.setPlaying(true);
    now.advance(60000);
    assert.equal(session.finish(), 0);
    assert.deepEqual(logger.getTotals(), {});
});

test('setPlaying after finish is ignored', () => {
    const now = fakeNow();
    const logger = createLocalLogger(fakeStorage());
    const session = createSession({ project: 'Atlas', logger, now });
    session.setPlaying(true);
    now.advance(60000);
    session.finish();
    session.setPlaying(true);
    now.advance(60000);
    assert.equal(session.elapsedMs(), 60000);
    assert.equal(session.isFinished(), true);
});

test('session that never played logs nothing', () => {
    const logger = createLocalLogger(fakeStorage());
    const session = createSession({ project: 'Atlas', logger, now: fakeNow() });
    assert.equal(session.finish(), 0);
    assert.deepEqual(logger.getTotals(), {});
});

// --- Spotify state interpretation ---
console.log('\nspotify state');

// Fixtures from the spike logs (Safari, 2026-11-05).
const URIS = {
    'Wild Ride': 'spotify:track:4tuzGcsy8X9uCg5if3yuwP',
    'Big Mon': 'spotify:track:0qmNuReXgs4dOT7il3gMyP',
    'Black Mountain Rag': 'spotify:track:1B4zObnZbdqUBjE7v6aWOK',
};
const PLAYLIST = Object.values(URIS);
const track = (name) => ({ name, uri: URIS[name] });

function state(paused, position, current, prev = [], next = []) {
    return {
        paused,
        position,
        track_window: {
            current_track: track(current),
            previous_tracks: prev.map(track),
            next_tracks: next.map(track),
        },
    };
}

// Feed states through and collect the non-null changes.
function replay(states, uris = PLAYLIST) {
    let tracker = initialTracker();
    const changes = [];
    for (const s of states) {
        const result = nextTrackerState(tracker, s, uris);
        tracker = result.tracker;
        if (result.change) changes.push(result.change);
    }
    return changes;
}

test('bursts of identical states produce one change', () => {
    const changes = replay([
        state(false, 0, 'Wild Ride', [], ['Big Mon']),
        state(false, 0, 'Wild Ride', [], ['Big Mon']),
        state(false, 1207, 'Wild Ride', [], ['Big Mon']),
        state(false, 113400, 'Wild Ride', [], ['Big Mon']),
    ]);
    assert.deepEqual(changes, [{ playing: true, trackIndex: 0, ended: false }]);
});

test('spike log 1: track change then pause, no end', () => {
    const changes = replay([
        state(false, 0, 'Wild Ride', [], ['Big Mon']),
        state(false, 113400, 'Wild Ride', [], ['Big Mon']),
        state(false, 0, 'Big Mon', ['Wild Ride'], ['Black Mountain Rag']),
        state(false, 0, 'Big Mon', ['Wild Ride'], ['Black Mountain Rag']),
        state(false, 1986, 'Big Mon', ['Wild Ride'], ['Black Mountain Rag']),
        state(true, 22716, 'Big Mon', ['Wild Ride'], ['Black Mountain Rag']),
        state(true, 22716, 'Big Mon', ['Wild Ride'], ['Black Mountain Rag']),
    ]);
    assert.deepEqual(changes, [
        { playing: true, trackIndex: 0, ended: false },
        { playing: true, trackIndex: 1, ended: false },
        { playing: false, trackIndex: 1, ended: false },
    ]);
});

test('spike log 2: wrap to track 1 after the last track ends the session', () => {
    const changes = replay([
        state(false, 0, 'Wild Ride', [], ['Big Mon']),
        state(false, 0, 'Big Mon', ['Wild Ride'], ['Black Mountain Rag']),
        state(false, 0, 'Black Mountain Rag', ['Big Mon'], []),
        state(false, 180553, 'Black Mountain Rag', ['Big Mon'], []),
        // Transitional state, then the reset queue.
        state(true, 0, 'Wild Ride', ['Black Mountain Rag'], []),
        state(true, 0, 'Wild Ride', ['Black Mountain Rag'], []),
        state(true, 0, 'Wild Ride', [], ['Big Mon']),
    ]);
    assert.deepEqual(changes.at(-1), { playing: false, trackIndex: 2, ended: true });
    assert.equal(changes.filter(c => c.ended).length, 1);
});

test('end is detected even if only the reset state arrives', () => {
    const changes = replay([
        state(false, 0, 'Black Mountain Rag', ['Big Mon'], []),
        state(true, 0, 'Wild Ride', [], ['Big Mon']),
    ]);
    assert.deepEqual(changes.at(-1), { playing: false, trackIndex: 2, ended: true });
});

test('pausing on the last track is not an end', () => {
    const changes = replay([
        state(false, 0, 'Black Mountain Rag', ['Big Mon'], []),
        state(true, 0, 'Black Mountain Rag', ['Big Mon'], []),
        state(true, 95000, 'Black Mountain Rag', ['Big Mon'], []),
    ]);
    assert.equal(changes.some(c => c.ended), false);
    assert.deepEqual(changes.at(-1), { playing: false, trackIndex: 2, ended: false });
});

test('paused at the start of track 1 before playing is not an end', () => {
    const changes = replay([state(true, 0, 'Wild Ride', [], ['Big Mon'])]);
    assert.deepEqual(changes, [{ playing: false, trackIndex: 0, ended: false }]);
});

test('null state (device lost) ends the session', () => {
    const changes = replay([state(false, 0, 'Big Mon', ['Wild Ride'], ['Black Mountain Rag']), null]);
    assert.deepEqual(changes.at(-1), { playing: false, trackIndex: 1, ended: true });
});

test('states after the end are ignored', () => {
    const changes = replay([
        state(false, 0, 'Black Mountain Rag', ['Big Mon'], []),
        state(true, 0, 'Wild Ride', [], ['Big Mon']),
        state(false, 0, 'Wild Ride', [], ['Big Mon']),
    ]);
    assert.equal(changes.length, 2);
    assert.equal(changes.at(-1).ended, true);
});

test('relinked track matches our list via linked_from', () => {
    const s = state(false, 0, 'Big Mon');
    s.track_window.current_track = { name: 'Big Mon', uri: 'spotify:track:REGIONALCOPY', linked_from: { uri: URIS['Big Mon'] } };
    assert.equal(currentTrackUri(s), URIS['Big Mon']);
    assert.deepEqual(replay([s]), [{ playing: true, trackIndex: 1, ended: false }]);
});

test('unknown track keeps the last known index', () => {
    const foreign = state(false, 0, 'Wild Ride');
    foreign.track_window.current_track = { name: 'Other', uri: 'spotify:track:OTHER' };
    const changes = replay([state(false, 0, 'Big Mon'), foreign]);
    assert.deepEqual(changes, [{ playing: true, trackIndex: 1, ended: false }]);
});

// --- Spotify playback adapter (SDK faked) ---
console.log('\nspotify playback adapter');

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        failed++;
    }
}

// Stands in for Spotify.Player; `calls` records the order of interactions.
function fakeSdk({ failWith = null } = {}) {
    const calls = [];
    let instance = null;
    class Player {
        constructor(opts) {
            this.opts = opts;
            this.handlers = {};
            instance = this;
        }
        addListener(event, cb) { (this.handlers[event] ||= []).push(cb); }
        fire(event, arg) { (this.handlers[event] || []).forEach(cb => cb(arg)); }
        async connect() {
            calls.push('connect');
            setTimeout(() => failWith
                ? this.fire(failWith, { message: 'nope' })
                : this.fire('ready', { device_id: 'dev1' }), 0);
            return true;
        }
        activateElement() { calls.push('activate'); return Promise.resolve(); }
        pause() { calls.push('pause'); return Promise.resolve(); }
        resume() { calls.push('resume'); return Promise.resolve(); }
    }
    const fetchFn = async (url, opts) => {
        calls.push({ url, method: opts.method, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
        return { ok: true, status: 204 };
    };
    return { loadSdk: async () => ({ Player }), fetchFn, calls, player: () => instance };
}

async function readyAdapter(sdk = fakeSdk()) {
    const playback = createSpotifyPlayback({ getToken: async () => 'tok', loadSdk: sdk.loadSdk, fetchFn: sdk.fetchFn });
    await playback.init();
    return { playback, sdk };
}

const TRACKS = Object.entries(URIS).map(([name, uri]) => ({ uri, name }));

await testAsync('play activates the element before the API call, then sends all URIs to our device', async () => {
    const { playback, sdk } = await readyAdapter();
    await playback.play(TRACKS);
    const activateAt = sdk.calls.indexOf('activate');
    const request = sdk.calls.find(c => c.url);
    assert.ok(activateAt >= 0 && activateAt < sdk.calls.indexOf(request));
    assert.equal(request.url, 'https://api.spotify.com/v1/me/player/play?device_id=dev1');
    assert.equal(request.method, 'PUT');
    assert.equal(request.auth, 'Bearer tok');
    assert.deepEqual(request.body, { uris: PLAYLIST });
});

await testAsync('getOAuthToken hands the SDK our token', async () => {
    const { sdk } = await readyAdapter();
    const token = await new Promise(resolve => sdk.player().opts.getOAuthToken(resolve));
    assert.equal(token, 'tok');
});

await testAsync('init rejects on account_error (not Premium)', async () => {
    const sdk = fakeSdk({ failWith: 'account_error' });
    await assert.rejects(readyAdapter(sdk), /account_error/);
});

await testAsync('state changes are forwarded once, and the end pauses the player', async () => {
    const { playback, sdk } = await readyAdapter();
    const changes = [];
    playback.onStateChange(c => changes.push(c));
    await playback.play(TRACKS);
    const fire = (s) => sdk.player().fire('player_state_changed', s);
    fire(state(false, 0, 'Black Mountain Rag', ['Big Mon'], []));
    fire(state(false, 0, 'Black Mountain Rag', ['Big Mon'], []));
    fire(state(true, 0, 'Wild Ride', ['Black Mountain Rag'], []));
    fire(state(true, 0, 'Wild Ride', [], ['Big Mon']));
    assert.deepEqual(changes, [
        { playing: true, trackIndex: 2, ended: false },
        { playing: false, trackIndex: 2, ended: true },
    ]);
    assert.equal(sdk.calls.at(-1), 'pause');
});

await testAsync('states before play() are ignored', async () => {
    const { playback, sdk } = await readyAdapter();
    const changes = [];
    playback.onStateChange(c => changes.push(c));
    sdk.player().fire('player_state_changed', state(false, 0, 'Wild Ride'));
    assert.deepEqual(changes, []);
});

await testAsync('stop pauses and ignores later states', async () => {
    const { playback, sdk } = await readyAdapter();
    const changes = [];
    playback.onStateChange(c => changes.push(c));
    await playback.play(TRACKS);
    sdk.player().fire('player_state_changed', state(false, 0, 'Wild Ride'));
    await playback.stop();
    sdk.player().fire('player_state_changed', state(false, 5000, 'Big Mon'));
    assert.equal(changes.length, 1);
    assert.equal(sdk.calls.at(-1), 'pause');
});

// --- session display helpers ---
console.log('\nsession display');

test('formatClock under an hour', () => {
    assert.equal(formatClock(0), '0:00');
    assert.equal(formatClock(65000), '1:05');
    assert.equal(formatClock(59 * 60000 + 59999), '59:59');
});

test('formatClock from an hour on', () => {
    assert.equal(formatClock(3600000), '1:00:00');
    assert.equal(formatClock(2 * 3600000 + 5 * 60000 + 7000), '2:05:07');
});

test('remainingMs: rest of current track plus later tracks', () => {
    const tracks = [{ duration_ms: 1000 }, { duration_ms: 2000 }, { duration_ms: 3000 }];
    assert.equal(remainingMs(tracks, 0, 0), 6000);
    assert.equal(remainingMs(tracks, 1, 500), 1500 + 3000);
    assert.equal(remainingMs(tracks, 2, 3000), 0);
});

test('remainingMs never counts negative time in the current track', () => {
    const tracks = [{ duration_ms: 1000 }, { duration_ms: 2000 }];
    assert.equal(remainingMs(tracks, 0, 5000), 2000);
});

test('remainingMs with no current track is 0', () => {
    assert.equal(remainingMs([{ duration_ms: 1000 }], -1, 0), 0);
});

// --- auth ---
console.log('\nauth');

test('hasScopes requires every scope', () => {
    assert.equal(hasScopes(SCOPES.join(' ')), true);
    assert.equal(hasScopes(SCOPES.filter(s => s !== 'streaming').join(' ')), false);
    assert.equal(hasScopes(null), false);
});

test('hasScopes ignores order and extra scopes', () => {
    assert.equal(hasScopes(['ugc-image-upload', ...[...SCOPES].reverse()].join('  ')), true);
});

// Fake token endpoint that records requests and returns `reply`.
function fakeTokenFetch(reply) {
    const requests = [];
    const fn = async (url, opts) => {
        requests.push(Object.fromEntries(opts.body));
        return { ok: true, status: 200, json: async () => reply };
    };
    fn.requests = requests;
    return fn;
}

function authWith({ storage = fakeStorage(), fetchFn = fakeTokenFetch({}), now = fakeNow(1_000_000) } = {}) {
    return { auth: createAuth({ clientId: 'cid', redirectUri: 'http://x/track/index.html', storage, fetchFn, now }), storage, fetchFn, now };
}

await testAsync('callback stores tokens under track_ keys only, plus the granted scope', async () => {
    const fetchFn = fakeTokenFetch({ access_token: 'A', refresh_token: 'R', expires_in: 3600, scope: SCOPES.join(' ') });
    const { auth, storage } = authWith({ fetchFn });
    storage.setItem(STORAGE_KEYS.verifier, 'v');
    assert.equal(await auth.handleCallback('?code=abc'), true);
    assert.equal(fetchFn.requests[0].code_verifier, 'v');
    assert.equal(fetchFn.requests[0].redirect_uri, 'http://x/track/index.html');
    assert.ok(Object.keys(storage.data).every(k => k.startsWith('track_')));
    assert.equal(storage.getItem(STORAGE_KEYS.verifier), null);
    assert.equal(auth.isLoggedIn(), true);
});

await testAsync('no code in the URL is not a callback', async () => {
    const { auth, fetchFn } = authWith();
    assert.equal(await auth.handleCallback(''), false);
    assert.equal(fetchFn.requests.length, 0);
});

test('a token without the streaming scope is not logged in (spike-era token)', () => {
    const { auth, storage } = authWith();
    storage.setItem(STORAGE_KEYS.access, 'A');
    assert.equal(auth.isLoggedIn(), false);
    storage.setItem(STORAGE_KEYS.scope, 'user-read-private playlist-read-private');
    assert.equal(auth.isLoggedIn(), false);
});

test('does not see the root app session', () => {
    const { auth, storage } = authWith();
    storage.setItem('spotify_access_token', 'ROOT');
    assert.equal(auth.isLoggedIn(), false);
});

await testAsync('getToken returns the stored token when not near expiry', async () => {
    const { auth, storage, fetchFn, now } = authWith();
    storage.setItem(STORAGE_KEYS.access, 'A');
    storage.setItem(STORAGE_KEYS.expiry, String(now() + 3600000));
    assert.equal(await auth.getToken(), 'A');
    assert.equal(fetchFn.requests.length, 0);
});

await testAsync('getToken refreshes within 5 minutes of expiry, keeping the old refresh token', async () => {
    const fetchFn = fakeTokenFetch({ access_token: 'B', expires_in: 3600, scope: SCOPES.join(' ') });
    const { auth, storage, now } = authWith({ fetchFn });
    storage.setItem(STORAGE_KEYS.access, 'A');
    storage.setItem(STORAGE_KEYS.refresh, 'R');
    storage.setItem(STORAGE_KEYS.expiry, String(now() + 60000));
    assert.equal(await auth.getToken(), 'B');
    assert.equal(fetchFn.requests[0].grant_type, 'refresh_token');
    assert.equal(fetchFn.requests[0].refresh_token, 'R');
    assert.equal(storage.getItem(STORAGE_KEYS.refresh), 'R');
});

await testAsync('getToken returns null when the refresh fails', async () => {
    const fetchFn = async () => ({ ok: false, status: 400 });
    const { auth, storage } = authWith({ fetchFn });
    storage.setItem(STORAGE_KEYS.access, 'A');
    storage.setItem(STORAGE_KEYS.refresh, 'R');
    storage.setItem(STORAGE_KEYS.expiry, '0');
    const originalError = console.error;
    console.error = () => {};
    try {
        assert.equal(await auth.getToken(), null);
    } finally {
        console.error = originalError;
    }
});

test('logout removes only track_ keys', () => {
    const { auth, storage } = authWith();
    storage.setItem('spotify_access_token', 'ROOT');
    storage.setItem('pomodorify_hours', '{}');
    for (const k of Object.values(STORAGE_KEYS)) storage.setItem(k, 'x');
    auth.logout();
    assert.deepEqual(Object.keys(storage.data).sort(), ['pomodorify_hours', 'spotify_access_token']);
});

// --- export ---
console.log('\nexport');

test('CSV has a header and rows sorted by project, hours to 2 decimals', () => {
    assert.equal(
        totalsToCsv({ beta: 1.005, Alpha: 2, gamma: 0.3333333 }),
        'project,hours\r\nAlpha,2.00\r\nbeta,1.00\r\ngamma,0.33\r\n',
    );
});

test('CSV quotes a project name containing a comma', () => {
    assert.equal(totalsToCsv({ 'Atlas, mapping': 1 }), 'project,hours\r\n"Atlas, mapping",1.00\r\n');
});

test('CSV doubles quotes inside a quoted name', () => {
    assert.equal(totalsToCsv({ 'The "big" one': 1 }), 'project,hours\r\n"The ""big"" one",1.00\r\n');
});

test('CSV quotes a name containing a newline', () => {
    assert.equal(totalsToCsv({ 'two\nlines': 1 }), 'project,hours\r\n"two\nlines",1.00\r\n');
});

test('CSV of empty totals is just the header', () => {
    assert.equal(totalsToCsv({}), 'project,hours\r\n');
});

test('JSON keeps full precision and round-trips', () => {
    const totals = { Atlas: 0.3333333333, 'Board, game': 2 };
    assert.deepEqual(JSON.parse(totalsToJson(totals)), totals);
});

test('describeTotals sums hours and counts projects', () => {
    assert.equal(describeTotals({ a: 10, b: 2.4, c: 0 }), '12.40 h across 3 projects');
    assert.equal(describeTotals({ a: 1 }), '1.00 h across 1 project');
});

// --- playlists ---
console.log('\nplaylists');

const pl = (id, name = id) => ({ id, name });

test('partitionPlaylists separates POMO_ saved sessions from sources, keeping order', () => {
    const { sources, saved } = partitionPlaylists([pl('a', 'Bluegrass'), pl('b', 'POMO_x_Nov06'), pl('c', 'Ambient'), pl('d', 'POMO_y')]);
    assert.deepEqual(sources.map(p => p.id), ['a', 'c']);
    assert.deepEqual(saved.map(p => p.id), ['b', 'd']);
});

test('partitionPlaylists only matches the prefix at the start', () => {
    const { saved } = partitionPlaylists([pl('a', 'My POMO_ list')]);
    assert.deepEqual(saved, []);
});

// random() values that pick each insertion slot explicitly.
const randoms = (...values) => { let i = 0; return () => values[i++]; };

test('orderReplays with no stored order inserts at random positions (a shuffle)', () => {
    // a -> [a]; b at slot 0 -> [b, a]; c at slot 1 of 3 -> [b, c, a]
    const { order } = orderReplays([pl('a'), pl('b'), pl('c')], [], randoms(0, 0, 0.5));
    assert.deepEqual(order, ['b', 'c', 'a']);
});

test('orderReplays keeps the stored order on later loads', () => {
    const saved = [pl('a'), pl('b'), pl('c')];
    const random = () => { throw new Error('should not need randomness'); };
    const { ordered, order } = orderReplays(saved, ['c', 'a', 'b'], random);
    assert.deepEqual(order, ['c', 'a', 'b']);
    assert.deepEqual(ordered.map(p => p.id), ['c', 'a', 'b']);
});

test('orderReplays drops deleted playlists and inserts new ones', () => {
    // stored [c, x, a]; x deleted -> [c, a]; b new at slot 1 -> [c, b, a]
    const { order } = orderReplays([pl('a'), pl('b'), pl('c')], ['c', 'x', 'a'], randoms(0.5));
    assert.deepEqual(order, ['c', 'b', 'a']);
});

test('orderReplays ignores duplicate ids in the stored order', () => {
    const { order } = orderReplays([pl('a'), pl('b')], ['a', 'a', 'b']);
    assert.deepEqual(order, ['a', 'b']);
});

test('orderReplays with the default random is a permutation', () => {
    const saved = ['a', 'b', 'c', 'd', 'e'].map(id => pl(id));
    const { order } = orderReplays(saved);
    assert.deepEqual([...order].sort(), ['a', 'b', 'c', 'd', 'e']);
});

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
