// The YouTube Data API key. A key restricted to this site's referrers can be
// baked in as BUILT_IN_KEY; a pasted key (kept in browser storage) overrides it.

export const BUILT_IN_KEY = '';
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
