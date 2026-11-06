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
