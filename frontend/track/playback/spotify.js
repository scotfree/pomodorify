// Spotify playback adapter: plays a track list in this tab via the Web Playback SDK.
// Implements the Playback adapter interface from DESIGN_V2.md. Premium only.

import { initialTracker, nextTrackerState } from './spotify-state.js';

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const READY_TIMEOUT_MS = 15000;

// Loads the SDK once and resolves with the global `Spotify` namespace.
let sdkPromise = null;
export function loadSpotifySdk() {
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve) => {
        if (window.Spotify) return resolve(window.Spotify);
        // The SDK calls this global once it has loaded; it must exist first.
        window.onSpotifyWebPlaybackSDKReady = () => resolve(window.Spotify);
        const script = document.createElement('script');
        script.src = SDK_URL;
        document.head.appendChild(script);
    });
    return sdkPromise;
}

// getToken: async () => access token (refreshing as needed).
// loadSdk / fetchFn are injectable for tests.
export function createSpotifyPlayback({
    getToken,
    name = 'Pomodorify',
    loadSdk = loadSpotifySdk,
    fetchFn = (...args) => fetch(...args),
}) {
    let player = null;
    let deviceId = null;
    let uris = [];
    let tracker = { ...initialTracker(), ended: true }; // nothing playing yet
    const listeners = [];

    function emit(change) {
        for (const cb of listeners) cb(change);
    }

    function handleState(state) {
        const result = nextTrackerState(tracker, state, uris);
        tracker = result.tracker;
        if (!result.change) return;
        // At the end the SDK has looped back to track 1; make sure it stays quiet.
        if (result.change.ended) player.pause().catch(() => {});
        emit(result.change);
    }

    return {
        async init() {
            const Spotify = await loadSdk();
            player = new Spotify.Player({
                name,
                getOAuthToken: async (cb) => cb(await getToken()),
                volume: 0.8,
            });

            const ready = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Spotify player did not become ready')), READY_TIMEOUT_MS);
                player.addListener('ready', ({ device_id }) => {
                    clearTimeout(timer);
                    deviceId = device_id;
                    resolve();
                });
                // account_error means the account isn't Premium.
                for (const event of ['initialization_error', 'authentication_error', 'account_error']) {
                    player.addListener(event, ({ message }) => {
                        clearTimeout(timer);
                        reject(new Error(`${event}: ${message}`));
                    });
                }
            });

            player.addListener('player_state_changed', handleState);
            player.addListener('playback_error', ({ message }) => console.warn('Spotify playback_error:', message));
            player.addListener('not_ready', () => console.warn('Spotify player went offline'));

            const connected = await player.connect();
            if (!connected) throw new Error('Spotify player failed to connect');
            await ready;
        },

        // Call from a click handler: browsers block audio not started by a user
        // gesture, so activateElement() runs before anything is awaited.
        async play(tracks) {
            const activated = player.activateElement();
            uris = tracks.map(t => t.uri);
            tracker = initialTracker();
            await activated;

            const response = await fetchFn(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${await getToken()}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ uris }),
            });
            if (!response.ok) {
                throw new Error(`Failed to start playback: ${response.status}`);
            }
        },

        pause: () => player.pause(),
        resume: () => player.resume(),

        // Ends the session from our side: silence the player and ignore any
        // further states. Doesn't emit; the caller already knows it stopped.
        async stop() {
            tracker = { ...tracker, ended: true };
            await player.pause();
        },

        onStateChange(cb) {
            listeners.push(cb);
        },
    };
}
