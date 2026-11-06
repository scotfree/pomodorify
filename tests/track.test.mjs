import assert from 'node:assert/strict';
import { createLocalLogger } from '../frontend/track/loggers/local.js';
import { createSessionClock, createSession, formatClock, remainingMs } from '../frontend/track/session.js';
import { createAuth, hasScopes, SCOPES, STORAGE_KEYS } from '../frontend/track/auth.js';
import { currentTrackUri, initialTracker, nextTrackerState } from '../frontend/track/playback/spotify-state.js';
import { createSpotifyPlayback } from '../frontend/track/playback/spotify.js';
import { totalsToCsv, totalsToJson, describeTotals } from '../frontend/track/export.js';
import { partitionPlaylists, orderReplays } from '../frontend/track/playlists.js';
import { createGithubSettings, parseFieldNames, DEFAULT_HOURS_FIELDS, GITHUB_KEYS } from '../frontend/track/github/settings.js';
import { resolveHoursTarget, roundHours, describeTarget } from '../frontend/track/github/hours-target.js';
import { createGithubLogger, commentBody } from '../frontend/track/loggers/github.js';
import { createGithubApi } from '../frontend/track/github/api.js';
import { parseProjectChoice, issueLabel, defaultRepoId } from '../frontend/track/github/picker.js';

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

// --- GitHub settings ---
console.log('\ngithub settings');

test('field names default to Worked Hours then Time Actual[hours]', () => {
    const settings = createGithubSettings(fakeStorage());
    assert.deepEqual(settings.getFieldNames(), ['Worked Hours', 'Time Actual[hours]']);
});

test('parseFieldNames trims, drops blanks, and falls back to defaults when empty', () => {
    assert.deepEqual(parseFieldNames(' a , b,, c '), ['a', 'b', 'c']);
    assert.deepEqual(parseFieldNames(' , '), DEFAULT_HOURS_FIELDS);
});

test('settings persist the token and field names under track_ keys', () => {
    const storage = fakeStorage();
    const settings = createGithubSettings(storage);
    settings.setToken('  ghp_x  ');
    settings.setFieldNames('Hours, Other');
    assert.equal(storage.data[GITHUB_KEYS.token], 'ghp_x');
    assert.deepEqual(createGithubSettings(storage).getFieldNames(), ['Hours', 'Other']);
    assert.ok(Object.keys(storage.data).every(k => k.startsWith('track_')));
    settings.clearToken();
    assert.equal(settings.getToken(), '');
});

// --- hours target resolution ---
console.log('\ngithub hours target');

// Shaped like ISSUE_HOURS_QUERY results (taken from a real Salmon-Creek-Systems issue).
// Empty {} nodes are what GitHub returns for field types the fragments don't match.
function issueNode({ orgFields = true, issueValues = [], projectItems = [] } = {}) {
    return {
        id: 'I_1',
        number: 132,
        title: 'Parcel data',
        repository: {
            id: 'R_1',
            nameWithOwner: 'Salmon-Creek-Systems/internal',
            owner: orgFields
                ? { __typename: 'Organization', login: 'Salmon-Creek-Systems', issueFields: { nodes: [
                    {}, { id: 'IFN_scoped', name: 'Scoped Hours' }, { id: 'IFN_worked', name: 'Worked Hours' }, {},
                ] } }
                : { __typename: 'User', login: 'scotfree' },
        },
        issueFieldValues: { nodes: issueValues },
        projectItems: { nodes: projectItems },
    };
}

const atlasItem = (number) => ({
    id: 'PVTI_1',
    project: { id: 'PVT_4', title: 'Stewardship Atlas', fields: { nodes: [
        { id: 'PVTF_title', name: 'Title', dataType: 'TITLE' },
        { id: 'PVTF_est', name: 'Time Est', dataType: 'NUMBER' },
        { id: 'PVTF_actual', name: 'Time Actual[hours]', dataType: 'NUMBER' },
    ] } },
    fieldValues: { nodes: number == null ? [{}] : [{}, { number, field: { id: 'PVTF_actual', name: 'Time Actual[hours]' } }] },
});

test('org issue field wins, with an unset value counting as 0', () => {
    const target = resolveHoursTarget(issueNode({ projectItems: [atlasItem(4)] }), DEFAULT_HOURS_FIELDS);
    assert.deepEqual(target, {
        kind: 'issueField', issueId: 'I_1', fieldId: 'IFN_worked', fieldName: 'Worked Hours', current: 0,
    });
});

test('org issue field reads its current value', () => {
    const issue = issueNode({ issueValues: [{ value: 2.5, field: { id: 'IFN_worked', name: 'Worked Hours' } }, {}] });
    assert.equal(resolveHoursTarget(issue, DEFAULT_HOURS_FIELDS).current, 2.5);
});

test('falls back to a project number field when the org has no matching issue field', () => {
    const target = resolveHoursTarget(issueNode({ orgFields: false, projectItems: [atlasItem(4)] }), DEFAULT_HOURS_FIELDS);
    assert.equal(target.kind, 'projectField');
    assert.equal(target.projectId, 'PVT_4');
    assert.equal(target.itemId, 'PVTI_1');
    assert.equal(target.fieldId, 'PVTF_actual');
    assert.equal(target.current, 4);
});

test('an unset project field counts as 0', () => {
    const target = resolveHoursTarget(issueNode({ orgFields: false, projectItems: [atlasItem(null)] }), DEFAULT_HOURS_FIELDS);
    assert.equal(target.current, 0);
});

test('names are tried in order: an earlier project field beats a later issue field', () => {
    const target = resolveHoursTarget(issueNode({ projectItems: [atlasItem(1)] }), ['Time Actual[hours]', 'Worked Hours']);
    assert.equal(target.kind, 'projectField');
});

test('name matching ignores case and surrounding spaces', () => {
    assert.equal(resolveHoursTarget(issueNode(), [' worked hours ']).fieldId, 'IFN_worked');
});

test('non-number project fields with a matching name are ignored', () => {
    assert.equal(resolveHoursTarget(issueNode({ orgFields: false, projectItems: [atlasItem(1)] }), ['Title']).kind, 'comment');
});

test('no matching field means a comment', () => {
    const target = resolveHoursTarget(issueNode({ orgFields: false }), DEFAULT_HOURS_FIELDS);
    assert.deepEqual(target, { kind: 'comment', issueId: 'I_1' });
});

test('roundHours and describeTarget', () => {
    assert.equal(roundHours(0.1 + 0.2), 0.3);
    assert.equal(describeTarget({ kind: 'comment' }), 'No hours field found: logs a comment.');
    assert.equal(describeTarget({ kind: 'issueField', fieldName: 'Worked Hours', current: 1.234 }),
        'Adds to Worked Hours, now 1.23 h.');
});

// --- GitHub logger ---
console.log('\ngithub logger');

// A fake api over one issue: tracks writes and lets a call fail on demand.
function fakeGithubApi(node) {
    const calls = [];
    const comments = [];
    const api = {
        calls,
        comments,
        failNext: null,  // method name whose next call throws
        node,
        async getIssueHoursInfo(id) { calls.push(['read', id]); return api.node; },
        async setIssueFieldNumber(issueId, fieldId, value, opts) {
            calls.push(['issueField', fieldId, value, Boolean(opts?.keepalive)]);
            if (api.failNext === 'setIssueFieldNumber') { api.failNext = null; throw new Error('network'); }
            api.node = { ...api.node, issueFieldValues: { nodes: [{ value, field: { id: fieldId } }] } };
        },
        async setProjectFieldNumber(projectId, itemId, fieldId, value, opts) {
            calls.push(['projectField', fieldId, value, Boolean(opts?.keepalive)]);
        },
        async addComment(issueId, body, opts) {
            calls.push(['comment', Boolean(opts?.keepalive)]);
            if (api.failNext === 'addComment') { api.failNext = null; throw new Error('network'); }
            comments.push(body);
        },
        async hasComment(issueId, text) { return comments.some(c => c.includes(text)); },
    };
    return api;
}

function githubLoggerWith(api, storage = fakeStorage()) {
    let n = 0;
    return createGithubLogger({
        api, storage, getFieldNames: () => DEFAULT_HOURS_FIELDS,
        now: () => Date.UTC(2026, 10, 6, 12), newId: () => `s${++n}`,
    });
}

const workedValue = (value) => ({ issueValues: [{ value, field: { id: 'IFN_worked', name: 'Worked Hours' } }] });

await testAsync('log adds to the issue field, re-reading first (fresh)', async () => {
    const api = fakeGithubApi(issueNode(workedValue(1.5)));
    const result = await githubLoggerWith(api).log('I_1', 0.4166);
    assert.deepEqual(result, { kind: 'issueField', fieldName: 'Worked Hours', value: 1.92 });
    assert.deepEqual(api.calls, [['read', 'I_1'], ['issueField', 'IFN_worked', 1.92, false]]);
});

await testAsync('log adds to a project field', async () => {
    const api = fakeGithubApi(issueNode({ orgFields: false, projectItems: [atlasItem(4)] }));
    const result = await githubLoggerWith(api).log('I_1', 1);
    assert.equal(result.value, 5);
    assert.deepEqual(api.calls.at(-1), ['projectField', 'PVTF_actual', 5, false]);
});

await testAsync('log posts a comment with a session marker when there is no field', async () => {
    const api = fakeGithubApi(issueNode({ orgFields: false }));
    const result = await githubLoggerWith(api).log('I_1', 0.5);
    assert.equal(result.kind, 'comment');
    assert.equal(api.comments[0], commentBody(0.5, '2026-11-06', 's1'));
    assert.match(api.comments[0], /0\.50 hours worked/);
    assert.match(api.comments[0], /<!-- pomodorify-session:s1 -->/);
});

await testAsync('pagehide log uses the prepared target: one keepalive write, no read', async () => {
    const api = fakeGithubApi(issueNode(workedValue(1)));
    const logger = githubLoggerWith(api);
    await logger.prepare('I_1');
    api.calls.length = 0;
    await logger.log('I_1', 0.5, { fresh: false });
    assert.deepEqual(api.calls, [['issueField', 'IFN_worked', 1.5, true]]);
});

await testAsync('pagehide log with nothing prepared is queued, not sent', async () => {
    const api = fakeGithubApi(issueNode());
    const logger = githubLoggerWith(api);
    assert.deepEqual(await logger.log('I_1', 0.5, { fresh: false }), { kind: 'queued' });
    assert.equal(api.calls.length, 0);
    assert.equal(logger.pendingCount(), 1);
    await logger.retryPending();
    assert.deepEqual(api.calls.at(-1), ['issueField', 'IFN_worked', 0.5, false]);
    assert.equal(logger.pendingCount(), 0);
});

await testAsync('a failed write stays queued and is sent by retryPending', async () => {
    const storage = fakeStorage();
    const api = fakeGithubApi(issueNode(workedValue(2)));
    api.failNext = 'setIssueFieldNumber';
    await assert.rejects(githubLoggerWith(api, storage).log('I_1', 1), /network/);
    const later = githubLoggerWith(api, storage);  // next page load
    assert.equal(later.pendingCount(), 1);
    assert.equal(await later.retryPending(), 1);
    assert.deepEqual(api.calls.at(-1), ['issueField', 'IFN_worked', 3, false]);
    assert.equal(later.pendingCount(), 0);
});

await testAsync('retry does not add twice when the earlier field write actually landed', async () => {
    const storage = fakeStorage();
    const api = fakeGithubApi(issueNode(workedValue(2)));
    const logger = githubLoggerWith(api, storage);
    // Simulate a write that reached GitHub but whose response was lost (tab closed).
    const realSet = api.setIssueFieldNumber;
    api.setIssueFieldNumber = async (...args) => { await realSet(...args); throw new Error('response lost'); };
    await assert.rejects(logger.log('I_1', 1), /response lost/);
    api.setIssueFieldNumber = realSet;
    api.calls.length = 0;
    assert.equal(await githubLoggerWith(api, storage).retryPending(), 1);
    assert.ok(!api.calls.some(c => c[0] === 'issueField'), 'no second write');
});

await testAsync('retry does not post a comment twice', async () => {
    const storage = fakeStorage();
    const api = fakeGithubApi(issueNode({ orgFields: false }));
    const realAdd = api.addComment;
    api.addComment = async (...args) => { await realAdd(...args); throw new Error('response lost'); };
    await assert.rejects(githubLoggerWith(api, storage).log('I_1', 1), /response lost/);
    api.addComment = realAdd;
    await githubLoggerWith(api, storage).retryPending();
    assert.equal(api.comments.length, 1);
});

await testAsync('a failed comment is posted on retry', async () => {
    const storage = fakeStorage();
    const api = fakeGithubApi(issueNode({ orgFields: false }));
    api.failNext = 'addComment';
    await assert.rejects(githubLoggerWith(api, storage).log('I_1', 1), /network/);
    await githubLoggerWith(api, storage).retryPending();
    assert.equal(api.comments.length, 1);
});

// --- GitHub api ---
console.log('\ngithub api');

function fakeGraphqlFetch(replies) {
    const requests = [];
    const fetchFn = async (url, init) => {
        requests.push({ url, init, body: JSON.parse(init.body) });
        const reply = replies.shift();
        return { ok: reply.status ? reply.status < 400 : true, status: reply.status ?? 200, json: async () => reply.json };
    };
    fetchFn.requests = requests;
    return fetchFn;
}

await testAsync('graphql sends the bearer token and throws on GraphQL errors', async () => {
    const fetchFn = fakeGraphqlFetch([{ json: { errors: [{ message: 'Bad credentials' }] } }]);
    const api = createGithubApi(() => 'ghp_t', fetchFn);
    await assert.rejects(api.getViewer(), /Bad credentials/);
    assert.equal(fetchFn.requests[0].url, 'https://api.github.com/graphql');
    assert.equal(fetchFn.requests[0].init.headers.Authorization, 'Bearer ghp_t');
});

await testAsync('writes pass keepalive through to fetch', async () => {
    const fetchFn = fakeGraphqlFetch([{ json: { data: {} } }]);
    const api = createGithubApi(() => 't', fetchFn);
    await api.setIssueFieldNumber('I_1', 'F_1', 2, { keepalive: true });
    assert.equal(fetchFn.requests[0].init.keepalive, true);
    assert.deepEqual(fetchFn.requests[0].body.variables, { issue: 'I_1', field: 'F_1', value: 2 });
});

await testAsync('listRepoIssues follows page cursors', async () => {
    const issue = (n) => ({ id: `I_${n}`, number: n, title: `t${n}`, updatedAt: '', repository: { id: 'R', nameWithOwner: 'o/r' } });
    const fetchFn = fakeGraphqlFetch([
        { json: { data: { node: { issues: { nodes: [issue(1)], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } } } },
        { json: { data: { node: { issues: { nodes: [issue(2)], pageInfo: { hasNextPage: false } } } } } },
    ]);
    const issues = await createGithubApi(() => 't', fetchFn).listRepoIssues('R');
    assert.deepEqual(issues.map(i => i.number), [1, 2]);
    assert.equal(fetchFn.requests[1].body.variables.after, 'c1');
});

await testAsync('listProjectIssues keeps open issues only, newest first', async () => {
    const content = (n, state, updatedAt) => ({ content: {
        id: `I_${n}`, number: n, title: 't', updatedAt, state, repository: { id: 'R', nameWithOwner: 'o/r' } } });
    const fetchFn = fakeGraphqlFetch([{ json: { data: { node: { items: {
        nodes: [content(1, 'OPEN', '2026-01-01'), content(2, 'CLOSED', '2026-03-01'), { content: {} }, content(3, 'OPEN', '2026-02-01')],
        pageInfo: { hasNextPage: false } } } } } }]);
    const issues = await createGithubApi(() => 't', fetchFn).listProjectIssues('P');
    assert.deepEqual(issues.map(i => i.number), [3, 1]);
});

await testAsync('createIssue sends the label, parent, project and estimate', async () => {
    const fetchFn = fakeGraphqlFetch([{ json: { data: { createIssue: { issue: {
        id: 'I_9', number: 9, title: 'New', updatedAt: '', repository: { id: 'R', nameWithOwner: 'o/r' } } } } } }]);
    const issue = await createGithubApi(() => 't', fetchFn).createIssue({
        repoId: 'R', title: 'New', issueTypeId: 'IT_task', parentIssueId: 'I_epic', projectId: 'P',
        labelIds: ['L'], assigneeIds: ['U'], issueFields: [{ fieldId: 'F_est', numberValue: 3 }],
    });
    assert.equal(issue.number, 9);
    assert.deepEqual(fetchFn.requests[0].body.variables, {
        repo: 'R', title: 'New', type: 'IT_task', parent: 'I_epic', projects: ['P'],
        labels: ['L'], assignees: ['U'], fields: [{ fieldId: 'F_est', numberValue: 3 }],
    });
});

// --- picker helpers ---
console.log('\ngithub picker');

test('parseProjectChoice', () => {
    assert.deepEqual(parseProjectChoice('none'), { kind: 'none' });
    assert.deepEqual(parseProjectChoice(''), { kind: 'none' });
    assert.deepEqual(parseProjectChoice('repo:R_1'), { kind: 'repo', id: 'R_1' });
    assert.deepEqual(parseProjectChoice('project:PVT_a:b'), { kind: 'project', id: 'PVT_a:b' });
    assert.deepEqual(parseProjectChoice('repo:'), { kind: 'none' });
});

test('issueLabel', () => {
    assert.equal(issueLabel({ repo: 'o/r', number: 12, title: 'Fix it' }), 'o/r#12 Fix it');
});

test('defaultRepoId picks the most common repo, else the first repo', () => {
    const issues = [{ repoId: 'A' }, { repoId: 'B' }, { repoId: 'B' }];
    assert.equal(defaultRepoId(issues, [{ id: 'Z' }]), 'B');
    assert.equal(defaultRepoId([], [{ id: 'Z' }]), 'Z');
    assert.equal(defaultRepoId([], []), null);
});

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
