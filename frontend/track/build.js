// Build: turn a pasted list of songs into a duration-fitted playlist.
// Adapted from ../spotless/build.js for Spotify (the apps don't import each
// other's code).
//
// The list is a pool, not the playlist. Lines are shuffled and searched one at
// a time, taking the first usable result for each, until the duration is full
// (plus one track over, like selectTracksForDuration). Lines that aren't needed
// are never searched. If the pool runs out first, the gap is filled from the
// other usable results of the searches already made, then from an
// "instrumental bluegrass" search.
//
// A Spotify track link becomes its title (public oEmbed: Spotify removed
// GET /tracks/{id} in 2026, #7), which is searched like a typed line; the
// linked track is picked if it's among the results.
//
// Pure apart from the injected searchSong / spotifyTitle; returns a log of
// every step for the result screen.

export const FILLER_QUERY = 'instrumental bluegrass';

const SPOTIFY_TRACK = /^(?:https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?track\/|spotify:track:)([A-Za-z0-9]{22})(?:[/?#].*)?$/i;

// The Spotify track id in an open.spotify.com/track link or spotify:track URI.
export function spotifyTrackId(line) {
    return SPOTIFY_TRACK.exec(line.trim())?.[1] ?? null;
}

// Lines of the text box: trimmed, list markers ("1.", "2)", "-", "*", "•")
// removed, blanks and repeats dropped.
export function parseLines(text) {
    const seen = new Set();
    const lines = [];
    for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trim().replace(/^(?:\d+[.)]|[-*•])\s+/, '').replace(/\s+/g, ' ');
        const key = line.toLowerCase();
        if (!line || seen.has(key)) continue;
        seen.add(key);
        lines.push(line);
    }
    return lines;
}

// The Spotify query for a song name: the line, cleaned up.
export function songQuery(name) {
    return name.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
}

export function shuffle(list, random = Math.random) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// searchSong(query) -> { results: [{ track } | { id, name, reason }] }
// spotifyTitle(id) -> song title
// onLog(entry) is called as each entry is added, for a live log.
//
// Returns { tracks, log }. Log entries:
//   { kind: 'line', line, spotify?, query?, rejected: [{ name, reason }], pick, error? }
//   { kind: 'filler', source: 'results' | 'bluegrass', query?, picks, error? }
//   { kind: 'unused', count, lines }
export async function buildPlaylist({
    lines, minutes, searchSong, spotifyTitle, random = Math.random, onLog = () => {},
}) {
    const limitMs = minutes * 60 * 1000;
    const tracks = [];
    const chosen = new Set();
    const leftovers = [];  // other usable results of the searches made, in order
    const log = [];
    let total = 0;
    const full = () => total >= limitMs;
    const add = (track) => {
        tracks.push(track);
        chosen.add(track.uri);
        total += track.duration_ms;
    };
    const push = (entry) => {
        log.push(entry);
        onLog(entry, log);
    };

    const queue = shuffle(lines, random);
    let i = 0;
    for (; i < queue.length && !full(); i++) {
        const line = queue[i];
        const entry = { kind: 'line', line, rejected: [], pick: null };
        try {
            let name = line;
            const spotifyId = spotifyTrackId(line);
            if (spotifyId) {
                name = await spotifyTitle(spotifyId);
                entry.spotify = name;
            }
            entry.query = songQuery(name);
            let { results } = await searchSong(entry.query);
            if (spotifyId) results = linkedFirst(results, `spotify:track:${spotifyId}`);
            for (const r of results) {
                if (!r.track) {
                    if (!entry.pick) entry.rejected.push({ name: r.name, reason: r.reason });
                } else if (chosen.has(r.track.uri)) {
                    if (!entry.pick) entry.rejected.push({ name: r.track.name, reason: 'already in the playlist' });
                } else if (!entry.pick) {
                    entry.pick = r.track;
                    add(r.track);
                } else {
                    leftovers.push(r.track);
                }
            }
        } catch (error) {
            entry.error = error.message;
            if (error.reason === 'quotaExceeded') {
                push(entry);
                throw error;
            }
        }
        push(entry);
    }

    if (i < queue.length) push({ kind: 'unused', count: queue.length - i, lines: queue.slice(i) });

    if (!full()) {
        const picks = [];
        for (const track of shuffle(leftovers, random)) {
            if (full()) break;
            if (chosen.has(track.uri)) continue;
            add(track);
            picks.push(track);
        }
        if (leftovers.length > 0) push({ kind: 'filler', source: 'results', picks });
    }

    if (!full()) {
        const entry = { kind: 'filler', source: 'bluegrass', query: FILLER_QUERY, picks: [] };
        try {
            const { results } = await searchSong(FILLER_QUERY);
            for (const r of shuffle(results.filter(x => x.track), random)) {
                if (full()) break;
                if (chosen.has(r.track.uri)) continue;
                add(r.track);
                entry.picks.push(r.track);
            }
        } catch (error) {
            entry.error = error.message;
        }
        push(entry);
    }

    return { tracks, log, totalMs: total, limitMs };
}

// The linked track first, if the search found it and it's usable.
function linkedFirst(results, uri) {
    const i = results.findIndex(r => r.track?.uri === uri);
    return i > 0 ? [results[i], ...results.slice(0, i), ...results.slice(i + 1)] : results;
}

// Spotify's public oEmbed endpoint: no login, gives the title.
export async function fetchSpotifyTitle(id, fetchFn = (...args) => fetch(...args)) {
    const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${id}`)}`;
    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`Spotify lookup failed (${response.status})`);
    const { title } = await response.json();
    if (!title) throw new Error('Spotify gave no title');
    return title;
}
