// YouTube playback adapter: plays a track list in this tab with the IFrame
// Player API. Implements the Playback adapter interface from DESIGN_V2.md.
//
// The adapter moves through the list itself (loadVideoById per track) rather
// than using the player's own playlist, so a video that refuses to play
// (removed, or embedding blocked: errors 100, 101, 150) is skipped and the
// rest of the session carries on.

const API_URL = 'https://www.youtube.com/iframe_api';
const READY_TIMEOUT_MS = 15000;
const RESTART_AFTER_S = 3;

export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

// Loads the IFrame API once and resolves with the global `YT` namespace.
let apiPromise = null;
export function loadYoutubeApi() {
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve) => {
        if (window.YT?.Player) return resolve(window.YT);
        // The API calls this global once it has loaded; it must exist first.
        window.onYouTubeIframeAPIReady = () => resolve(window.YT);
        const script = document.createElement('script');
        script.src = API_URL;
        document.head.appendChild(script);
    });
    return apiPromise;
}

// element: the element (or its id) the player iframe replaces. It must be
// laid out (not display: none) and at least 200x200 px.
export function createYoutubePlayback({
    element,
    width = 356,
    height = 200,
    loadApi = loadYoutubeApi,
    readyTimeoutMs = READY_TIMEOUT_MS,
}) {
    let player = null;
    let ids = [];
    let index = -1;
    let active = false;  // a session is playing through the list
    let last = null;     // last emitted change, for dedup
    const listeners = [];

    function emit(change) {
        if (last && last.playing === change.playing && last.trackIndex === change.trackIndex
            && last.ended === change.ended) return;
        last = change;
        for (const cb of listeners) cb(change);
    }

    function advance() {
        if (index + 1 < ids.length) {
            index++;
            player.loadVideoById(ids[index]);
            emit({ playing: false, trackIndex: index, ended: false });
        } else {
            active = false;
            emit({ playing: false, trackIndex: index, ended: true });
        }
    }

    function onStateChange({ data }) {
        if (!active) return;
        if (data === YT_STATE.ENDED) advance();
        else emit({ playing: data === YT_STATE.PLAYING, trackIndex: index, ended: false });
    }

    function onError({ data }) {
        if (!active) return;
        console.warn(`YouTube error ${data} on video ${ids[index]}; skipping it`);
        advance();
    }

    return {
        async init() {
            const YT = await loadApi();
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('YouTube player did not become ready')), readyTimeoutMs);
                player = new YT.Player(element, {
                    width,
                    height,
                    playerVars: { playsinline: 1, rel: 0 },
                    events: {
                        onReady: () => {
                            clearTimeout(timer);
                            resolve();
                        },
                        onStateChange,
                        onError,
                    },
                });
            });
        },

        // Call from a click handler: browsers block audio not started by a user
        // gesture, so the video is loaded before anything is awaited.
        async play(tracks) {
            ids = tracks.map(t => t.id);
            index = 0;
            active = true;
            last = null;
            player.loadVideoById(ids[0]);
            emit({ playing: false, trackIndex: 0, ended: false });
        },

        // Skips to the next track; past the last one, the session ends.
        async next() {
            if (active) advance();
        },

        // Back to the start of this track, or to the previous track if this
        // one has only just started (like most players).
        async previous() {
            if (!active) return;
            if (index === 0 || player.getCurrentTime() > RESTART_AFTER_S) {
                player.seekTo(0, true);
                return;
            }
            index--;
            player.loadVideoById(ids[index]);
            emit({ playing: false, trackIndex: index, ended: false });
        },

        async pause() {
            player.pauseVideo();
        },

        async resume() {
            player.playVideo();
        },

        // Ends the session from our side. Doesn't emit; the caller already knows.
        async stop() {
            active = false;
            player.stopVideo();
        },

        onStateChange(cb) {
            listeners.push(cb);
        },
    };
}
