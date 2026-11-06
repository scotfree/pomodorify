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

// "PT1H2M3S" -> ms. "P0D" (live) and anything unparseable -> 0.
export function parseIsoDuration(iso) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(iso ?? ''));
    if (!m) return 0;
    const [, d = 0, h = 0, min = 0, s = 0] = m;
    return Math.round((((+d * 24 + +h) * 60 + +min) * 60 + +s) * 1000);
}

// videos.list items -> tracks, dropping live streams, unembeddable videos and
// anything outside the duration range. Keeps the API's order.
export function videosToTracks(items, { minMs = MIN_TRACK_MS, maxMs = MAX_TRACK_MS } = {}) {
    const tracks = [];
    for (const item of items ?? []) {
        if (item.snippet?.liveBroadcastContent && item.snippet.liveBroadcastContent !== 'none') continue;
        if (item.status?.embeddable === false) continue;
        const duration_ms = parseIsoDuration(item.contentDetails?.duration);
        if (duration_ms < minMs || duration_ms > maxMs) continue;
        tracks.push({
            id: item.id,
            name: item.snippet?.title ?? item.id,
            artist: item.snippet?.channelTitle ?? '',
            duration_ms,
        });
    }
    return tracks;
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
    async function searchIds(query, { categoryId, videoDuration } = {}) {
        const body = await get('search', {
            part: 'id',
            type: 'video',
            q: query,
            maxResults: 50,
            videoEmbeddable: 'true',
            videoSyndicated: 'true',  // playable outside youtube.com
            videoCategoryId: categoryId,
            videoDuration,
        });
        return (body.items ?? []).map(i => i.id?.videoId).filter(Boolean);
    }

    async function videos(ids) {
        if (ids.length === 0) return [];
        const body = await get('videos', { part: 'snippet,contentDetails,status', id: ids.join(','), maxResults: 50 });
        return body.items ?? [];
    }

    return {
        // Passes, stopping once there are enough tracks: 4-20 min music, then
        // short music (most songs are 2-4 min), then 4-20 min of anything
        // (e.g. "rain sounds" isn't in the Music category).
        async searchTracks(query, { enough = 15 } = {}) {
            const passes = [
                { categoryId: '10', videoDuration: 'medium' },
                { categoryId: '10', videoDuration: 'short' },
                { videoDuration: 'medium' },
            ];
            const tracks = [];
            const seen = new Set();
            for (const pass of passes) {
                const ids = (await searchIds(query, pass)).filter(id => !seen.has(id));
                for (const t of videosToTracks(await videos(ids))) {
                    seen.add(t.id);
                    tracks.push(t);
                }
                if (tracks.length >= enough) break;
            }
            return tracks;
        },
    };
}
