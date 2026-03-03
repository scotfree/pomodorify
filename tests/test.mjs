import assert from 'node:assert/strict';
import { formatDuration, selectTracksForDuration, generateRandomString } from '../frontend/utils.js';

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

// --- formatDuration ---
console.log('\nformatDuration');

test('formats whole minutes', () => {
    assert.equal(formatDuration(60000), '1:00');
});

test('formats minutes and seconds', () => {
    assert.equal(formatDuration(90000), '1:30');
});

test('pads single-digit seconds', () => {
    assert.equal(formatDuration(65000), '1:05');
});

test('handles zero', () => {
    assert.equal(formatDuration(0), '0:00');
});

test('handles sub-second values', () => {
    assert.equal(formatDuration(500), '0:00');
});

// --- selectTracksForDuration ---
console.log('\nselectTracksForDuration');

const track = (name, minutes) => ({ name, uri: name, artist: 'A', duration_ms: minutes * 60 * 1000 });
const identity = () => 0; // stable sort, preserves order

test('selects tracks up to duration', () => {
    const tracks = [track('a', 3), track('b', 3), track('c', 3)];
    const result = selectTracksForDuration(tracks, 6, identity);
    // 3+3 = 6 min fits, adding 'c' would exceed — but the function adds one over
    assert.equal(result.length, 3);
});

test('adds one track over the limit', () => {
    const tracks = [track('a', 3), track('b', 3), track('c', 3)];
    const result = selectTracksForDuration(tracks, 5, identity);
    // 'a' fits (3 min), 'b' would exceed 5 min — gets added as the one-over
    assert.equal(result.length, 2);
    const totalMs = result.reduce((sum, t) => sum + t.duration_ms, 0);
    assert.ok(totalMs > 5 * 60 * 1000);
});

test('returns empty for empty input', () => {
    const result = selectTracksForDuration([], 25, identity);
    assert.deepEqual(result, []);
});

test('returns all tracks when duration exceeds total', () => {
    const tracks = [track('a', 3), track('b', 3)];
    const result = selectTracksForDuration(tracks, 60, identity);
    assert.equal(result.length, 2);
});

test('does not mutate original array', () => {
    const tracks = [track('a', 3), track('b', 3)];
    selectTracksForDuration(tracks, 25, identity);
    assert.equal(tracks.length, 2);
});

test('uses injected shuffle function', () => {
    const tracks = [track('a', 3), track('b', 3), track('c', 3)];
    const reverse = (a, b) => b.name.localeCompare(a.name); // reverse alphabetical
    const result = selectTracksForDuration(tracks, 25, reverse);
    assert.equal(result[0].name, 'c');
});

// --- generateRandomString ---
console.log('\ngenerateRandomString');

test('returns correct length', () => {
    assert.equal(generateRandomString(128).length, 128);
    assert.equal(generateRandomString(10).length, 10);
});

test('only contains alphanumeric characters', () => {
    const result = generateRandomString(200);
    assert.match(result, /^[A-Za-z0-9]+$/);
});

test('returns different values each call', () => {
    assert.notEqual(generateRandomString(32), generateRandomString(32));
});

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
