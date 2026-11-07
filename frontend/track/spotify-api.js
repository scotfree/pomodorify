// Spotify Web API calls for the playlist builder and export. Adapted from app.js.

const BASE = 'https://api.spotify.com/v1';

// explicit and album are only used for filtering (search.js); saved
// playlists keep uri, name, artist and duration_ms.
function toTrack(t) {
    return {
        uri: t.uri,
        name: t.name,
        artist: t.artists[0]?.name ?? '',
        duration_ms: t.duration_ms,
        explicit: Boolean(t.explicit),
        album: t.album?.name ?? '',
    };
}

// Since February 2026 search returns at most 10 results per request (#7).
export const SEARCH_PAGE = 10;

// getToken: async () => access token.
export function createSpotifyApi(getToken, fetchFn = (...args) => fetch(...args)) {
    async function request(path, { method = 'GET', body } = {}) {
        const response = await fetchFn(`${BASE}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${await getToken()}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status}`);
        return response.status === 204 ? null : response.json();
    }

    return {
        getMe: () => request('/me'),

        // All of the user's playlists, sorted A-Z (POMO_ ones included; callers filter).
        async getPlaylists() {
            const all = [];
            const limit = 50;
            for (let offset = 0; ; offset += limit) {
                const page = await request(`/me/playlists?limit=${limit}&offset=${offset}`);
                all.push(...page.items.filter(Boolean));
                if (page.items.length < limit) break;
            }
            return all.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        },

        // First 100 tracks, as the root app does.
        async getPlaylistTracks(playlistId) {
            const data = await request(`/playlists/${playlistId}/tracks`);
            return data.items.filter(item => item.track).map(item => toTrack(item.track));
        },

        // Pages through results 10 at a time, up to `pages` pages.
        async searchTracks(query, { pages = 5 } = {}) {
            const all = [];
            for (let page = 0; page < pages; page++) {
                const data = await request(`/search?q=${encodeURIComponent(query)}&type=track`
                    + `&limit=${SEARCH_PAGE}&offset=${page * SEARCH_PAGE}`);
                const items = (data.tracks?.items ?? []).filter(Boolean);
                all.push(...items.map(toTrack));
                if (items.length < SEARCH_PAGE) break;
            }
            return all;
        },

        // Creates a private playlist and returns its Spotify URL.
        async savePlaylist(name, uris) {
            const me = await request('/me');
            const playlist = await request(`/users/${me.id}/playlists`, {
                method: 'POST',
                body: { name, public: false },
            });
            await request(`/playlists/${playlist.id}/tracks`, { method: 'POST', body: { uris } });
            return playlist.external_urls.spotify;
        },

        // Like savePlaylist, plus the new playlist's id.
        async savePlaylistWithId(name, uris) {
            const url = await this.savePlaylist(name, uris);
            return { url, id: url.split('/playlist/')[1]?.split('?')[0] ?? null };
        },
    };
}
