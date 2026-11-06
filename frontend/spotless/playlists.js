// Spotless playlists, kept in browser storage as JSON. Nothing is written to
// YouTube: a playlist is a name plus an ordered list of tracks.

export const PLAYLISTS_KEY = 'spotless_playlists';
export const EXPORT_VERSION = 1;

function isTrack(t) {
    return t && typeof t.id === 'string' && t.id
        && typeof t.duration_ms === 'number' && t.duration_ms > 0;
}

function isPlaylist(p) {
    return p && typeof p.id === 'string' && p.id
        && typeof p.name === 'string'
        && Array.isArray(p.tracks) && p.tracks.length > 0 && p.tracks.every(isTrack);
}

function cleanTrack(t) {
    return { id: t.id, name: String(t.name ?? t.id), artist: String(t.artist ?? ''), duration_ms: t.duration_ms };
}

// `storage` is anything with getItem/setItem. Tests pass a fake.
export function createPlaylistStore({
    storage = globalThis.localStorage,
    now = () => Date.now(),
    newId = () => `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
} = {}) {
    function read() {
        try {
            const list = JSON.parse(storage.getItem(PLAYLISTS_KEY));
            return Array.isArray(list) ? list.filter(isPlaylist) : [];
        } catch {
            return [];
        }
    }

    function write(list) {
        storage.setItem(PLAYLISTS_KEY, JSON.stringify(list));
    }

    return {
        // Newest first.
        list: () => read().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),

        get: (id) => read().find(p => p.id === id) ?? null,

        save({ name, query = '', minutes = null, tracks }) {
            const playlist = {
                id: newId(),
                name: String(name ?? '').trim() || query || 'Untitled',
                query,
                minutes,
                createdAt: now(),
                tracks: tracks.map(cleanTrack),
            };
            if (!isPlaylist(playlist)) throw new Error('A playlist needs at least one track.');
            write([...read(), playlist]);
            return playlist;
        },

        rename(id, name) {
            const trimmed = String(name ?? '').trim();
            if (!trimmed) return;
            write(read().map(p => (p.id === id ? { ...p, name: trimmed } : p)));
        },

        remove(id) {
            write(read().filter(p => p.id !== id));
        },

        exportJson() {
            return JSON.stringify({ version: EXPORT_VERSION, playlists: read() }, null, 2) + '\n';
        },

        // Adds playlists from an export (or a bare array of playlists). Ones
        // already here (same id) are skipped. Returns how many were added.
        importJson(text) {
            const parsed = JSON.parse(text);
            const incoming = Array.isArray(parsed) ? parsed : parsed?.playlists;
            if (!Array.isArray(incoming)) throw new Error('No playlists in that file.');
            const list = read();
            const ids = new Set(list.map(p => p.id));
            let added = 0;
            for (const p of incoming) {
                if (!isPlaylist(p) || ids.has(p.id)) continue;
                list.push({ ...p, tracks: p.tracks.map(cleanTrack) });
                ids.add(p.id);
                added++;
            }
            write(list);
            return added;
        },
    };
}
