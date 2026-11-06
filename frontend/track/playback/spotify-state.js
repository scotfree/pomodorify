// Interprets Web Playback SDK `player_state_changed` states against our track list.
// Pure, so the playback edge cases can be unit-tested without the SDK.
//
// Observed SDK behaviour (spike, Safari, 2026-11-05):
// - Each change arrives as a burst of 2-5 identical states.
// - A track change goes straight to the next track at position 0, not paused.
// - At the end of the playlist the player wraps back to track 1 and pauses. One
//   transitional state has the last track in previous_tracks, then the queue
//   resets and looks like "paused before starting". So end detection must be
//   stateful: we ended if we had reached the last track and then see a paused
//   state on an earlier track.

// The URI we asked for. With track relinking Spotify plays a regional copy and
// puts the original URI in linked_from.
export function currentTrackUri(state) {
    const track = state.track_window.current_track;
    if (!track) return null;
    return track.linked_from?.uri ?? track.uri;
}

export function initialTracker() {
    return { lastIndex: -1, lastKey: null, ended: false };
}

// Returns { tracker, change }. `change` is null when nothing we care about
// changed (duplicates, states after the end); otherwise it is the
// onStateChange payload { playing, trackIndex, ended }.
export function nextTrackerState(tracker, state, uris) {
    if (tracker.ended) return { tracker, change: null };

    // Null state: device lost or playback transferred away. Treat as stopped.
    if (!state) {
        return {
            tracker: { ...tracker, ended: true },
            change: { playing: false, trackIndex: tracker.lastIndex, ended: true },
        };
    }

    const index = uris.indexOf(currentTrackUri(state));
    const lastTrack = uris.length - 1;
    const wrapped = state.paused
        && tracker.lastIndex === lastTrack
        && index >= 0
        && index < tracker.lastIndex;

    if (wrapped) {
        return {
            tracker: { ...tracker, ended: true },
            change: { playing: false, trackIndex: tracker.lastIndex, ended: true },
        };
    }

    // Unknown track (index -1): keep the last known position.
    const trackIndex = index >= 0 ? index : tracker.lastIndex;
    const playing = !state.paused;
    const key = `${playing}|${trackIndex}`;
    if (key === tracker.lastKey) return { tracker, change: null };

    return {
        tracker: { ...tracker, lastIndex: trackIndex, lastKey: key },
        change: { playing, trackIndex, ended: false },
    };
}
