// YouTube Data API v3: search for videos and turn them into tracks
// ({ id, name, artist, duration_ms }) that selectTracksForDuration can fit.
//
// Quota: search.list costs 100 units and videos.list 1, against a default of
// 10,000 units a day per key. A search here is 101 units when the first pass
// finds enough, up to 303 when it falls back.

const BASE = 'https://www.googleapis.com/youtube/v3';

// Shorter than this is usually a Short or a jingle; longer is usually a
// multi-hour mix, which would swallow a whole session in one "track".
export const MIN_TRACK_MS = 60 * 1000;
export const MAX_TRACK_MS = 20 * 60 * 1000;

// For a single named song (Build): tighter, so a 30-minute "full album" or a
// music video with a long intro isn't taken for the song.
export const SONG_RANGE = { minMs: 60 * 1000, maxMs: 12 * 60 * 1000 };

// "PT1H2M3S" -> ms. "P0D" (live) and anything unparseable -> 0.
export function parseIsoDuration(iso) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(iso ?? ''));
    if (!m) return 0;
    const [, d = 0, h = 0, min = 0, s = 0] = m;
    return Math.round((((+d * 24 + +h) * 60 + +min) * 60 + +s) * 1000);
}

// Why a video can't be a track, or null if it can.
function rejection(item, durationMs, { minMs, maxMs }) {
    const live = item.snippet?.liveBroadcastContent;
    if (live && live !== 'none') return live === 'upcoming' ? 'upcoming premiere' : 'live stream';
    if (item.status?.embeddable === false) return 'not embeddable';
    if (durationMs < minMs || durationMs > maxMs) return `${formatMinutes(durationMs)}, outside ${formatMinutes(minMs)}–${formatMinutes(maxMs)}`;
    return null;
}

function formatMinutes(ms) {
    const s = Math.round(ms / 1000);
    return s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${(s / 3600).toFixed(1)} h`;
}

// videos.list items -> [{ track } | { id, name, reason }], in the API's order.
export function classifyVideos(items, { minMs = MIN_TRACK_MS, maxMs = MAX_TRACK_MS } = {}) {
    return (items ?? []).map((item) => {
        const duration_ms = parseIsoDuration(item.contentDetails?.duration);
        const name = item.snippet?.title ?? item.id;
        const reason = rejection(item, duration_ms, { minMs, maxMs });
        if (reason) return { id: item.id, name, reason };
        return { track: { id: item.id, name, artist: item.snippet?.channelTitle ?? '', duration_ms } };
    });
}

// videos.list items -> tracks, dropping live streams, unembeddable videos and
// anything outside the duration range. Keeps the API's order.
export function videosToTracks(items, range) {
    return classifyVideos(items, range).filter(r => r.track).map(r => r.track);
}

// The Search popup's options. Lengths are in minutes.
export const SEARCH_DEFAULTS = {
    minMinutes: 2,
    maxMinutes: 5,
    instrumental: false,  // adds "instrumental"
    explicit: true,       // false: YouTube's SafeSearch "moderate"
    official: false,      // adds "official audio"
    noLive: false,        // excludes "live"
    noCovers: false,      // excludes "cover" and "remix"
};

// The search words for the options. YouTube search supports -word exclusions.
export function searchQuery(text, options = {}) {
    const o = { ...SEARCH_DEFAULTS, ...options };
    const parts = [String(text ?? '').trim()];
    if (o.instrumental) parts.push('instrumental');
    if (o.official) parts.push('"official audio"');
    if (o.noLive) parts.push('-live');
    if (o.noCovers) parts.push('-cover -remix');
    return parts.filter(Boolean).join(' ');
}

// YouTube's length filter only has buckets: short (<4 min), medium (4-20).
// Use whichever overlap the range; the exact range is filtered afterwards.
export function durationBuckets(minMs, maxMs) {
    const four = 4 * 60 * 1000;
    const buckets = [];
    if (minMs < four) buckets.push('short');
    if (maxMs > four) buckets.push('medium');
    return buckets;
}

// "2–5 min · instrumental · no live" for showing a search's options.
export function describeSearchOptions(options = {}) {
    const o = { ...SEARCH_DEFAULTS, ...options };
    const parts = [`${o.minMinutes}–${o.maxMinutes} min`];
    if (o.instrumental) parts.push('instrumental');
    if (!o.explicit) parts.push('no explicit');
    if (o.official) parts.push('official audio');
    if (o.noLive) parts.push('no live');
    if (o.noCovers) parts.push('no covers');
    return parts.join(' · ');
}

// getKey: () => API key. fetchFn is injectable for tests.
export function createYoutubeApi(getKey, fetchFn = (...args) => fetch(...args)) {
    async function get(path, params) {
        const url = new URL(`${BASE}/${path}`);
        for (const [k, v] of Object.entries({ ...params, key: getKey() })) {
            if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
        }
        const response = await fetchFn(url.toString());
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            const reason = body.error?.errors?.[0]?.reason;
            const message = body.error?.message || `YouTube API error ${response.status}`;
            const error = new Error(reason ? `${message} (${reason})` : message);
            error.reason = reason;
            throw error;
        }
        return body;
    }

    // videoDuration: 'medium' is 4-20 min, 'short' under 4 min. Without it,
    // popular searches ("lofi beats") are mostly hours-long mixes and streams.
    async function searchIds(query, { categoryId, videoDuration, maxResults = 50, safeSearch } = {}) {
        const body = await get('search', {
            part: 'id',
            type: 'video',
            q: query,
            maxResults,
            videoEmbeddable: 'true',
            videoSyndicated: 'true',  // playable outside youtube.com
            videoCategoryId: categoryId,
            videoDuration,
            safeSearch,
        });
        return (body.items ?? []).map(i => i.id?.videoId).filter(Boolean);
    }

    async function videos(ids) {
        if (ids.length === 0) return [];
        const body = await get('videos', { part: 'snippet,contentDetails,status', id: ids.join(','), maxResults: 50 });
        return body.items ?? [];
    }

    return {
        // Passes, stopping once there are enough tracks: Music in each length
        // bucket the range needs, then the same outside the Music category
        // (e.g. "rain sounds" isn't Music). Each pass is 101 quota units.
        async searchTracks(text, options = {}, { enough = 15 } = {}) {
            const o = { ...SEARCH_DEFAULTS, ...options };
            const range = { minMs: o.minMinutes * 60 * 1000, maxMs: o.maxMinutes * 60 * 1000 };
            const q = searchQuery(text, o);
            const safeSearch = o.explicit ? 'none' : 'moderate';
            const buckets = durationBuckets(range.minMs, range.maxMs);
            const passes = [
                ...buckets.map(videoDuration => ({ categoryId: '10', videoDuration })),
                ...buckets.map(videoDuration => ({ videoDuration })),
            ];
            const tracks = [];
            const seen = new Set();
            for (const pass of passes) {
                const ids = (await searchIds(q, { ...pass, safeSearch })).filter(id => !seen.has(id));
                for (const t of videosToTracks(await videos(ids), range)) {
                    seen.add(t.id);
                    tracks.push(t);
                }
                if (tracks.length >= enough) break;
            }
            return tracks;
        },

        // One song: the Music category, then all of YouTube if nothing there
        // is usable. Returns { results: classifyVideos output, passes } so the
        // build log can say what was rejected and why. 101 units, or 202.
        async searchSong(query, { range = SONG_RANGE, maxResults = 25 } = {}) {
            const results = [];
            let passes = 0;
            for (const categoryId of ['10', undefined]) {
                passes++;
                const ids = await searchIds(query, { categoryId, maxResults });
                const seen = new Set(results.map(r => r.track?.id ?? r.id));
                results.push(...classifyVideos(await videos(ids.filter(id => !seen.has(id))), range));
                if (results.some(r => r.track)) break;
            }
            return { results, passes };
        },
    };
}
