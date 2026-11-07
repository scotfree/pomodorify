// Options for making playlists from Spotify, and the filters behind them.
// Pure. Mirrors ../spotless/youtube-api.js's options, minus "official": every
// Spotify track is the official recording.
//
// Spotify search has no reliable -word exclusions, so length, explicit, live
// and covers are filtered from the results: Spotify gives each track's exact
// length and explicit flag.

export const SEARCH_DEFAULTS = {
    minMinutes: 2,
    maxMinutes: 5,
    instrumental: false,  // adds "instrumental" to the search
    explicit: true,       // false: drops tracks Spotify marks explicit
    live: false,          // false: drops live versions
    covers: false,        // false: drops covers and remixes
};

// For a single named song (List): wide, since you asked for that song.
export const SONG_RANGE = { minMinutes: 1, maxMinutes: 12 };

const hasWord = (text, word) => new RegExp(`\\b${word}\\b`, 'i').test(text ?? '');

export function searchQuery(text, options = {}) {
    const o = { ...SEARCH_DEFAULTS, ...options };
    const clean = String(text ?? '').trim().replace(/\s+/g, ' ');
    return o.instrumental && !hasWord(clean, 'instrumental') ? `${clean} instrumental` : clean;
}

function formatMinutes(ms) {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Why a track can't be used, or null if it can. `text` is what was searched:
// a word it contains is never held against a track, so "Live Forever" still
// finds the song.
export function rejection(track, text, options = {}) {
    const o = { ...SEARCH_DEFAULTS, ...options };
    const minMs = o.minMinutes * 60000;
    const maxMs = o.maxMinutes * 60000;
    if (!o.explicit && track.explicit) return 'explicit';
    if (track.duration_ms < minMs || track.duration_ms > maxMs) {
        return `${formatMinutes(track.duration_ms)}, outside ${formatMinutes(minMs)}–${formatMinutes(maxMs)}`;
    }
    if (!o.live && !hasWord(text, 'live') && (hasWord(track.name, 'live') || hasWord(track.album, 'live'))) {
        return 'live version';
    }
    if (!o.covers) {
        for (const word of ['cover', 'remix']) {
            if (!hasWord(text, word) && hasWord(track.name, word)) return word === 'cover' ? 'cover' : 'remix';
        }
    }
    return null;
}

export function filterTracks(tracks, text, options) {
    return tracks.filter(t => !rejection(t, text, options));
}

// "2–5 min · instrumental · no explicit · with live" for showing a search's options.
export function describeSearchOptions(options = {}) {
    const o = { ...SEARCH_DEFAULTS, ...options };
    const parts = [`${o.minMinutes}–${o.maxMinutes} min`];
    if (o.instrumental) parts.push('instrumental');
    if (!o.explicit) parts.push('no explicit');
    parts.push(...describeShared(o));
    return parts.join(' · ');
}

// The Live / Covers row, as words. The defaults (no live, no covers) say nothing.
export function describeShared(o = {}) {
    const parts = [];
    if (o.live) parts.push('with live');
    if (o.covers) parts.push('with covers');
    return parts;
}
