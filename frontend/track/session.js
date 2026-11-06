// Session timing and logging. No DOM, no SDK: driven by setPlaying() calls.

// Accumulates time only while playing. setPlaying is idempotent, so repeated
// "playing" reports (the SDK sends bursts of identical states) don't double count.
export function createSessionClock(now = () => Date.now()) {
    let accumulatedMs = 0;
    let runningSince = null;

    return {
        setPlaying(playing) {
            if (playing && runningSince === null) {
                runningSince = now();
            } else if (!playing && runningSince !== null) {
                accumulatedMs += now() - runningSince;
                runningSince = null;
            }
        },

        elapsedMs() {
            return accumulatedMs + (runningSince === null ? 0 : now() - runningSince);
        },
    };
}

// Clock display: "4:05" under an hour, "1:04:05" from an hour on.
export function formatClock(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = String(totalSeconds % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// Planned time left: the rest of the current track plus every later track.
// `msInCurrentTrack` comes from the session clock (elapsed now minus elapsed
// when the track started), so it only drifts if the user seeks.
export function remainingMs(tracks, trackIndex, msInCurrentTrack) {
    if (trackIndex < 0 || trackIndex >= tracks.length) return 0;
    const current = Math.max(0, tracks[trackIndex].duration_ms - msInCurrentTrack);
    const later = tracks.slice(trackIndex + 1).reduce((sum, t) => sum + t.duration_ms, 0);
    return current + later;
}

// One tracked session. finish() logs the elapsed hours exactly once, so Stop,
// playlist end and pagehide can all call it without double logging.
export function createSession({ project = '', logger, now = () => Date.now() }) {
    const clock = createSessionClock(now);
    let finished = false;

    return {
        setPlaying(playing) {
            if (!finished) clock.setPlaying(playing);
        },

        elapsedMs: () => clock.elapsedMs(),

        isFinished: () => finished,

        // Returns the hours logged (0 if nothing was logged).
        finish() {
            if (finished) return 0;
            clock.setPlaying(false);
            finished = true;
            const hours = clock.elapsedMs() / 3600000;
            if (!project.trim() || hours <= 0) return 0;
            logger.addHours(project, hours);
            return hours;
        },
    };
}
