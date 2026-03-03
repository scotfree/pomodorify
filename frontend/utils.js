export function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function selectTracksForDuration(tracks, durationMinutes, shuffleFn = () => Math.random() - 0.5) {
    const durationLimit = durationMinutes * 60 * 1000;
    const shuffledTracks = [...tracks].sort(shuffleFn);

    const selectedTracks = [];
    let totalDuration = 0;

    for (const track of shuffledTracks) {
        if (totalDuration + track.duration_ms <= durationLimit) {
            selectedTracks.push(track);
            totalDuration += track.duration_ms;
        } else {
            selectedTracks.push(track);
            totalDuration += track.duration_ms;
            break;
        }
    }

    return selectedTracks;
}

export function generateRandomString(length) {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function getShortTimestamp() {
    const now = new Date();
    const month = now.toLocaleDateString('en-US', { month: 'short' });
    const day = now.getDate().toString().padStart(2, '0');
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    return `${month}${day}_${hours}${minutes}`;
}
