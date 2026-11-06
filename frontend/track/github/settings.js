// GitHub settings for the track app: a pasted token and the ordered list of
// number-field names that hours are added to. Kept in browser storage.

export const GITHUB_KEYS = {
    token: 'track_github_token',
    fields: 'track_github_hours_fields',
};

// Tried in order. "Worked Hours" is the Salmon-Creek-Systems org issue field;
// "Time Actual[hours]" is an older Projects v2 field on the Stewardship Atlas project.
export const DEFAULT_HOURS_FIELDS = ['Worked Hours', 'Time Actual[hours]'];

// "a, b ,, c" -> ['a', 'b', 'c']. Empty input means the defaults.
export function parseFieldNames(text) {
    const names = String(text ?? '').split(',').map(s => s.trim()).filter(Boolean);
    return names.length > 0 ? names : [...DEFAULT_HOURS_FIELDS];
}

export function createGithubSettings(storage = globalThis.localStorage) {
    return {
        getToken: () => storage.getItem(GITHUB_KEYS.token) || '',

        setToken(token) {
            const trimmed = String(token ?? '').trim();
            if (trimmed) storage.setItem(GITHUB_KEYS.token, trimmed);
            else storage.removeItem(GITHUB_KEYS.token);
        },

        clearToken: () => storage.removeItem(GITHUB_KEYS.token),

        getFieldNames() {
            try {
                const stored = JSON.parse(storage.getItem(GITHUB_KEYS.fields));
                if (Array.isArray(stored) && stored.length > 0) return stored;
            } catch {
                // fall through to defaults
            }
            return [...DEFAULT_HOURS_FIELDS];
        },

        setFieldNames(text) {
            storage.setItem(GITHUB_KEYS.fields, JSON.stringify(parseFieldNames(text)));
        },
    };
}
