// Spotify PKCE auth for the track app. Adapted from app.js, with two changes:
// every storage key is prefixed `track_` so this app never touches the root
// app's session, and the granted scope is stored so a token from before a
// scope was added sends the user back to login.

import { generateRandomString } from '../utils.js';

export const SCOPES = [
    'streaming',
    'user-read-email',
    'user-read-private',
    'playlist-read-private',
    'playlist-modify-private',
    'user-read-playback-state',
    'user-modify-playback-state',
];

export const STORAGE_KEYS = {
    access: 'track_spotify_access_token',
    refresh: 'track_spotify_refresh_token',
    expiry: 'track_spotify_token_expiry',
    scope: 'track_spotify_scope',
    verifier: 'track_code_verifier',
};

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// `granted` is Spotify's space-separated scope string.
export function hasScopes(granted, required = SCOPES) {
    const have = new Set((granted || '').split(/\s+/).filter(Boolean));
    return required.every(s => have.has(s));
}

async function codeChallenge(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function createAuth({
    clientId,
    redirectUri,
    storage = globalThis.localStorage,
    fetchFn = (...args) => fetch(...args),
    now = () => Date.now(),
    navigate = (url) => { window.location.href = url; },
}) {
    const K = STORAGE_KEYS;

    function saveTokens(data) {
        storage.setItem(K.access, data.access_token);
        if (data.refresh_token) storage.setItem(K.refresh, data.refresh_token);
        if (data.scope !== undefined) storage.setItem(K.scope, data.scope);
        storage.setItem(K.expiry, String(now() + data.expires_in * 1000));
    }

    async function tokenRequest(params) {
        const response = await fetchFn('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: clientId, ...params }),
        });
        if (!response.ok) throw new Error(`Spotify token request failed: ${response.status}`);
        saveTokens(await response.json());
    }

    return {
        async login() {
            const verifier = generateRandomString(128);
            storage.setItem(K.verifier, verifier);
            const params = new URLSearchParams({
                client_id: clientId,
                response_type: 'code',
                redirect_uri: redirectUri,
                scope: SCOPES.join(' '),
                code_challenge_method: 'S256',
                code_challenge: await codeChallenge(verifier),
            });
            navigate(`https://accounts.spotify.com/authorize?${params}`);
        },

        // Exchanges ?code=… if present. Returns true if it handled a callback.
        async handleCallback(search) {
            const code = new URLSearchParams(search).get('code');
            if (!code) return false;
            const verifier = storage.getItem(K.verifier);
            if (!verifier) throw new Error('No code verifier found');
            await tokenRequest({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                code_verifier: verifier,
            });
            storage.removeItem(K.verifier);
            return true;
        },

        // Logged in = we hold a token that was granted every scope we need.
        isLoggedIn() {
            return Boolean(storage.getItem(K.access)) && hasScopes(storage.getItem(K.scope));
        },

        // Returns a valid access token, refreshing when near expiry; null if logged out.
        async getToken() {
            const token = storage.getItem(K.access);
            if (!token) return null;
            const expiry = Number(storage.getItem(K.expiry) || 0);
            if (now() < expiry - REFRESH_MARGIN_MS) return token;

            const refresh = storage.getItem(K.refresh);
            if (!refresh) return null;
            try {
                await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
            } catch (error) {
                console.error(error);
                return null;
            }
            return storage.getItem(K.access);
        },

        logout() {
            Object.values(K).forEach(k => storage.removeItem(k));
        },
    };
}
