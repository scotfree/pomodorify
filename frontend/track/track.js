// Pomodorify Track: build a duration-fitted playlist, play it in this tab,
// and log the time actually played against a project. See DESIGN_V2.md.

import { formatDuration, selectTracksForDuration, getShortTimestamp } from '../utils.js';
import { createAuth, STORAGE_KEYS } from './auth.js';
import { createSpotifyApi } from './spotify-api.js';
import { createSpotifyPlayback } from './playback/spotify.js';
import { createLocalLogger } from './loggers/local.js';
import { createSession, formatClock, remainingMs } from './session.js';
import { totalsToCsv, totalsToJson, describeTotals } from './export.js';
import { partitionPlaylists, orderReplays } from './playlists.js';

const REPLAY_ORDER_KEY = 'track_replay_order';

const CLIENT_ID = 'bac207f49dc041e0a2e8a92691c7a23a';
const REDIRECT_URI = window.location.hostname === '127.0.0.1'
    ? `http://${window.location.host}/track/index.html`
    : 'https://pomodorifi.es/track/index.html';

const BACKGROUNDS = [
    '../assets/tta_icetroid.jpg',
    '../assets/robots.jpeg',
    '../assets/ringscape.jpeg',
    '../assets/suits.jpeg',
    '../assets/redcity.jpeg',
    '../assets/tta_city.jpg',
    '../assets/tta_city2.jpg',
];

const SECTIONS = ['login-section', 'playlist-section', 'preview-section', 'session-section', 'result-section'];

const $ = (id) => document.getElementById(id);

const auth = createAuth({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
const api = createSpotifyApi(auth.getToken);
const playback = createSpotifyPlayback({ getToken: auth.getToken, name: 'Pomodorify' });
const logger = createLocalLogger();

let preview = null;        // { tracks, sourceName }
let playerReady = false;
let session = null;
let sessionTracks = [];
let current = { index: -1, startedAtMs: 0 };  // track position, in session-clock time
let playing = false;
let ticker = null;

// --- sections ---

function showSection(id) {
    for (const section of SECTIONS) {
        $(section).style.display = section === id ? 'block' : 'none';
    }
}

function setRandomBackground() {
    const bg = BACKGROUNDS[Math.floor(Math.random() * BACKGROUNDS.length)];
    $('bg').style.backgroundImage =
        `linear-gradient(rgba(25, 25, 35, 0.4), rgba(25, 25, 35, 0.4)), url('${bg}')`;
}

// --- playlist builder ---

async function loadPlaylists() {
    const select = $('playlist-select');
    try {
        const { sources, saved } = partitionPlaylists(await api.getPlaylists());
        select.replaceChildren(new Option('-- Select a playlist --', ''));
        for (const p of sources) select.add(new Option(p.name, p.id));
        renderReplays(saved);
    } catch (error) {
        console.error(error);
        select.replaceChildren(new Option('Error loading playlists', ''));
    }
}

function readReplayOrder() {
    try {
        const stored = JSON.parse(localStorage.getItem(REPLAY_ORDER_KEY));
        return Array.isArray(stored) ? stored : [];
    } catch {
        return [];
    }
}

// Saved sessions in a random order that stays the same between visits.
function renderReplays(saved) {
    const { ordered, order } = orderReplays(saved, readReplayOrder());
    localStorage.setItem(REPLAY_ORDER_KEY, JSON.stringify(order));
    const select = $('replay-select');
    select.replaceChildren(new Option('-- Choose a saved session --', ''));
    for (const p of ordered) select.add(new Option(p.name, p.id));
    $('replay-group').hidden = ordered.length === 0;
}

// A replay plays the saved playlist exactly: in order, no shuffle, no fitting.
async function replay() {
    const select = $('replay-select');
    const playlistId = select.value;
    if (!playlistId) return;
    const sourceName = select.options[select.selectedIndex].textContent;
    select.value = '';  // so choosing the same one again still fires `change`
    try {
        const tracks = await api.getPlaylistTracks(playlistId);
        if (tracks.length === 0) {
            alert('That saved session has no tracks.');
            return;
        }
        preview = { tracks, sourceName, isReplay: true };
        renderPreview();
        showSection('preview-section');
    } catch (error) {
        console.error(error);
        alert('Failed to load the saved session. Please try again.');
    }
}

// --- logged totals ---

function renderTotals() {
    const totals = logger.getTotals();
    const projects = Object.keys(totals).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    $('totals').hidden = projects.length === 0;
    $('totals-body').replaceChildren(...projects.map((project) => {
        const row = document.createElement('tr');
        const name = document.createElement('td');
        name.textContent = project;
        const hours = document.createElement('td');
        hours.textContent = totals[project].toFixed(2);
        row.append(name, hours);
        return row;
    }));
}

function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function clearTotals() {
    const totals = logger.getTotals();
    if (!confirm(`Delete ${describeTotals(totals)}? This can't be undone.`)) return;
    logger.clear();
    renderTotals();
}

function sanitizeSearch(query) {
    return query.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, ' ').trim().substring(0, 30);
}

async function generate() {
    const query = $('search-input').value.trim();
    const playlistId = $('playlist-select').value;
    const minutes = parseInt($('duration').value, 10);

    if (!query && !playlistId) {
        alert('Please select a playlist or enter a search term.');
        return;
    }

    try {
        let tracks;
        let sourceName;
        if (query) {
            tracks = await api.searchTracks(query);
            sourceName = `search_${sanitizeSearch(query)}`;
        } else {
            tracks = await api.getPlaylistTracks(playlistId);
            const select = $('playlist-select');
            sourceName = select.options[select.selectedIndex].textContent;
        }
        if (tracks.length === 0) {
            alert('No tracks found.');
            return;
        }
        preview = { tracks: selectTracksForDuration(tracks, minutes), sourceName };
        renderPreview();
        showSection('preview-section');
    } catch (error) {
        console.error(error);
        alert('Failed to generate playlist. Please try again.');
    }
}

function trackRow(track) {
    const row = document.createElement('div');
    row.className = 'track-item';
    const info = document.createElement('div');
    info.className = 'track-info';
    const name = document.createElement('div');
    name.className = 'track-name';
    name.textContent = track.name;
    const artist = document.createElement('div');
    artist.className = 'track-artist';
    artist.textContent = track.artist;
    const duration = document.createElement('div');
    duration.className = 'track-duration';
    duration.textContent = formatDuration(track.duration_ms);
    info.append(name, artist);
    row.append(info, duration);
    return row;
}

function renderPreview() {
    const total = preview.tracks.reduce((sum, t) => sum + t.duration_ms, 0);
    $('preview-source-name').textContent = preview.sourceName;
    $('preview-duration').textContent = formatDuration(total);
    $('preview-track-count').textContent = String(preview.tracks.length);
    $('preview-tracks').replaceChildren(...preview.tracks.map(trackRow));
    $('preview-playlist-name').value = `POMO_${preview.sourceName}_${getShortTimestamp()}`;
    // REBUILD would only reshuffle a fixed playlist, and SAVE would copy a saved one.
    $('regenerate-button').hidden = Boolean(preview.isReplay);
    document.querySelector('.export').hidden = Boolean(preview.isReplay);
    $('project-list').replaceChildren(...Object.keys(logger.getTotals()).sort().map(p => new Option(p)));
}

// --- export (SAVE) ---

async function save() {
    const name = $('preview-playlist-name').value.trim()
        || `POMO_${preview.sourceName}_${getShortTimestamp()}`;
    try {
        const url = await api.savePlaylist(name, preview.tracks.map(t => t.uri));
        $('playlist-link').href = url;
        showSection('result-section');
        loadPlaylists();  // so the new saved session appears in the replay list
    } catch (error) {
        console.error(error);
        alert('Failed to save playlist. Please try again.');
    }
}

// --- tracked session ---

// Runs inside the click handler with nothing awaited before playback.play(),
// so the browser counts the audio as user-initiated.
function startSession() {
    const project = $('project-input').value.trim();
    session = createSession({ project, logger });
    sessionTracks = preview.tracks;
    current = { index: -1, startedAtMs: 0 };
    playing = false;

    $('session-project').textContent = project || 'No project (not logging)';
    $('session-track-name').textContent = 'Starting…';
    $('session-track-artist').textContent = '';
    $('session-controls').hidden = false;
    $('session-done').hidden = true;
    renderSession();
    showSection('session-section');
    ticker = setInterval(renderSession, 500);

    playback.play(sessionTracks).catch((error) => {
        console.error(error);
        alert('Failed to start playback. Please try again.');
        endSession();
    });
}

function onPlaybackChange(change) {
    if (!session || session.isFinished()) return;
    session.setPlaying(change.playing);
    playing = change.playing;
    $('pause-button').textContent = playing ? 'PAUSE' : 'RESUME';

    if (change.trackIndex !== current.index && change.trackIndex >= 0) {
        current = { index: change.trackIndex, startedAtMs: session.elapsedMs() };
        const track = sessionTracks[change.trackIndex];
        $('session-track-name').textContent = track.name;
        $('session-track-artist').textContent = track.artist;
    }

    if (change.ended) endSession();
    else renderSession();
}

function renderSession() {
    if (!session) return;
    const elapsed = session.elapsedMs();
    $('session-elapsed').textContent = formatClock(elapsed);
    if (current.index >= 0) {
        const left = remainingMs(sessionTracks, current.index, elapsed - current.startedAtMs);
        $('session-progress').textContent =
            `Track ${current.index + 1} of ${sessionTracks.length} · ${Math.ceil(left / 60000)} min left`;
    } else {
        $('session-progress').textContent = '';
    }
}

// Safe to call more than once: session.finish() only logs the first time.
function endSession() {
    if (!session || session.isFinished()) return;
    renderSession();
    const project = $('project-input').value.trim();
    const hours = session.finish();
    clearInterval(ticker);
    ticker = null;

    $('session-controls').hidden = true;
    $('session-done').hidden = false;
    $('session-progress').textContent = '';
    $('session-summary').textContent = hours > 0
        ? `Logged ${hours.toFixed(2)} h to ${project}.`
        : project ? 'Nothing played, so nothing was logged.' : 'No project, so nothing was logged.';
    renderTotals();
}

function togglePause() {
    (playing ? playback.pause() : playback.resume()).catch(console.error);
}

function stopSession() {
    endSession();
    playback.stop().catch(console.error);
}

// --- setup ---

async function setUpPlayer() {
    let premium = false;
    try {
        premium = (await api.getMe()).product === 'premium';
    } catch (error) {
        console.error(error);
    }
    $('premium-note').hidden = premium;
    if (!premium) return;

    try {
        await playback.init();
        playerReady = true;
        $('start-button').disabled = false;
    } catch (error) {
        console.error('Spotify player failed to start:', error);
        $('premium-note').textContent = `Playback unavailable: ${error.message}`;
        $('premium-note').hidden = false;
    }
}

function wireEvents() {
    $('login-button').addEventListener('click', () => auth.login());
    $('logout-button').addEventListener('click', () => {
        auth.logout();
        window.location.reload();
    });
    $('generate-button').addEventListener('click', generate);
    $('search-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') generate(); });
    $('back-button').addEventListener('click', () => showSection('playlist-section'));
    $('regenerate-button').addEventListener('click', generate);
    $('start-button').addEventListener('click', () => { if (playerReady && preview) startSession(); });
    $('save-button').addEventListener('click', save);
    $('pause-button').addEventListener('click', togglePause);
    $('stop-button').addEventListener('click', stopSession);
    $('new-session-button').addEventListener('click', () => showSection('playlist-section'));
    $('create-another-button').addEventListener('click', () => showSection('playlist-section'));
    $('replay-select').addEventListener('change', replay);
    $('export-json-button').addEventListener('click', () =>
        download('pomodorify-hours.json', totalsToJson(logger.getTotals()), 'application/json'));
    $('export-csv-button').addEventListener('click', () =>
        download('pomodorify-hours.csv', totalsToCsv(logger.getTotals()), 'text/csv'));
    $('clear-totals-button').addEventListener('click', clearTotals);
    playback.onStateChange(onPlaybackChange);
    // Closing the tab mid-session still logs the time played so far.
    window.addEventListener('pagehide', () => {
        if (session && !session.isFinished()) session.finish();
    });
}

async function boot() {
    setRandomBackground();
    wireEvents();

    try {
        if (await auth.handleCallback(window.location.search)) {
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    } catch (error) {
        console.error('Authentication failed:', error);
        alert('Authentication failed. Please try again.');
    }

    if (!auth.isLoggedIn()) {
        // A token without the needed scopes (e.g. from before `streaming` was added).
        if (localStorage.getItem(STORAGE_KEYS.access)) $('login-note').hidden = false;
        showSection('login-section');
        return;
    }

    showSection('playlist-section');
    renderTotals();
    loadPlaylists();
    setUpPlayer();
}

boot();
