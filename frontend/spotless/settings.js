// The YouTube Data API key. A key restricted to this site's referrers can be
// baked in as BUILT_IN_KEY; a pasted key (kept in browser storage) overrides it.

// Restricted in Google Cloud to the pomodorifi.es and 127.0.0.1:8080 referrers
// and to YouTube Data API v3 only, so it's safe to ship in page source.
export const BUILT_IN_KEY = 'AIzaSyDuoZptZXJfy1TEBrhDxW5nk6sN0siUOeA';
export const KEY_STORAGE = 'spotless_youtube_key';

export function createYoutubeSettings(storage = globalThis.localStorage, builtIn = BUILT_IN_KEY) {
    return {
        getKey: () => storage.getItem(KEY_STORAGE) || builtIn,
        hasPastedKey: () => Boolean(storage.getItem(KEY_STORAGE)),

        setKey(key) {
            const trimmed = String(key ?? '').trim();
            if (trimmed) storage.setItem(KEY_STORAGE, trimmed);
            else storage.removeItem(KEY_STORAGE);
        },

        clearKey: () => storage.removeItem(KEY_STORAGE),
    };
}
