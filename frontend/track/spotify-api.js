// Spotify Web API calls for the playlist builder and export. Adapted from app.js.

const BASE = 'https://api.spotify.com/v1';

function toTrack(t) {
    return { uri: t.uri, name: t.name, artist: t.artists[0]?.name ?? '', duration_ms: t.duration_ms };
}

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

        async searchTracks(query) {
            const data = await request(`/search?q=${encodeURIComponent(query)}&type=track&limit=50`);
            return data.tracks.items.map(toTrack);
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
    };
}
