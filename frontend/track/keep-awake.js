// Keeps the page counted as "playing audio" for a whole session.
//
// Why: Safari pauses JavaScript in pages you can't see unless they're playing
// audio. The Spotify player (an iframe in our page) plays each track, so the
// page counts as playing while a track is on. But in the silent gap between
// tracks Safari treats the page as idle and pauses it, including the
// player's own code that starts the next track, until the page is visible
// again. A tiny looping clip, far below hearing, bridges those gaps.
//
// start() must be called from a click (browsers only let a tap start audio).

// A mono 16-bit WAV of `seconds` of a ~-80 dBFS hum: inaudible, but not
// digital silence, in case a browser skips truly silent audio.
export function quietWav(seconds = 2, sampleRate = 8000) {
    const samples = Math.round(seconds * sampleRate);
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);            // fmt chunk size
    view.setUint16(20, 1, true);             // PCM
    view.setUint16(22, 1, true);             // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);             // block align
    view.setUint16(34, 16, true);            // bits per sample
    text(36, 'data');
    view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) {
        // ±3 out of 32767: about -80 dB, a 50 Hz hum nobody can hear.
        view.setInt16(44 + i * 2, Math.round(3 * Math.sin((2 * Math.PI * 50 * i) / sampleRate)), true);
    }
    return new Uint8Array(buffer);
}

export function createKeepAwake({
    createAudio = () => new Audio(),
    makeUrl = (bytes) => URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })),
} = {}) {
    let audio = null;

    return {
        // From the START click, before anything is awaited.
        start() {
            if (!audio) {
                audio = createAudio();
                audio.src = makeUrl(quietWav());
                audio.loop = true;
                audio.preload = 'auto';
                audio.setAttribute?.('playsinline', '');
            }
            audio.currentTime = 0;
            const playing = audio.play();
            playing?.catch?.((error) => console.warn('Keep-awake audio did not start:', error));
            return playing;
        },

        stop() {
            audio?.pause();
        },

        isRunning: () => Boolean(audio && !audio.paused),
    };
}
