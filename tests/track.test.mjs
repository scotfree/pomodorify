import assert from 'node:assert/strict';
import { createLocalLogger } from '../frontend/track/loggers/local.js';
import { createSessionClock, createSession } from '../frontend/track/session.js';
import { currentTrackUri, initialTracker, nextTrackerState } from '../frontend/track/playback/spotify-state.js';

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

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
