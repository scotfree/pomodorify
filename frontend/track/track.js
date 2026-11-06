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
import { createGithubSettings } from './github/settings.js';
import { createGithubApi } from './github/api.js';
import { describeTarget } from './github/hours-target.js';
import { createGithubLogger } from './loggers/github.js';
import {
    NO_PROJECT, NEW_ISSUE, DEFAULT_ISSUE_TYPE,
    parseProjectChoice, projectValue, issueLabel, defaultRepoId,
} from './github/picker.js';

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

const CREATED_LABEL = { name: 'pomodorify created', color: 'e4572e', description: 'Created from Pomodorify' };
const githubSettings = createGithubSettings();
const githubApi = createGithubApi(githubSettings.getToken);
const githubLogger = createGithubLogger({ api: githubApi, getFieldNames: githubSettings.getFieldNames });

// GitHub lists, loaded once a token is set. issues: cache keyed by Project choice value.
let github = { viewer: null, repos: [], projects: [], issues: new Map() };
let createInfo = null;     // getRepoCreateInfo() for the new-issue form's repo
let pageHiding = false;    // set on pagehide so the GitHub write uses keepalive

let preview = null;        // { tracks, sourceName }
let playerReady = false;
let session = null;
let sessionLabel = '';     // what the session logs to (title or issue label)
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

// --- GitHub: settings, Project/issue pickers, new issue ---

function setNote(id, text) {
    $(id).textContent = text || '';
    $(id).hidden = !text;
}

function renderGithubSettings() {
    $('github-fields').value = githubSettings.getFieldNames().join(', ');
    $('github-token').value = '';
    $('github-status').textContent = !githubSettings.getToken() ? 'No token set.'
        : github.viewer ? `Connected as ${github.viewer.login}.` : 'Token set.';
}

async function loadGithub() {
    github = { viewer: null, repos: [], projects: [], issues: new Map() };
    renderProjectOptions();
    if (!githubSettings.getToken()) {
        setNote('github-note', 'Add a GitHub token (below the playlist builder) to log time to issues.');
        renderGithubSettings();
        return;
    }
    setNote('github-note', 'Loading GitHub projects and repos…');
    try {
        github.viewer = await githubApi.getViewer();
        [github.projects, github.repos] = await Promise.all([githubApi.listProjects(), githubApi.listRepos()]);
        setNote('github-note', '');
    } catch (error) {
        console.error(error);
        setNote('github-note', `GitHub unavailable: ${error.message}`);
    }
    renderProjectOptions();
    renderGithubSettings();
    retryGithubPending();
}

async function retryGithubPending() {
    if (githubLogger.pendingCount() === 0) return;
    const done = await githubLogger.retryPending();
    const left = githubLogger.pendingCount();
    if (done > 0 || left > 0) {
        setNote('github-note', `Sent ${done} earlier GitHub update(s)${left ? `; ${left} still waiting` : ''}.`);
    }
}

function saveGithubSettings() {
    const token = $('github-token').value.trim();
    if (token) githubSettings.setToken(token);
    githubSettings.setFieldNames($('github-fields').value);
    loadGithub();
}

function removeGithubToken() {
    githubSettings.clearToken();
    loadGithub();
}

function renderProjectOptions() {
    const select = $('project-select');
    const previous = select.value;
    $('project-options').replaceChildren(...github.projects.map(p => new Option(p.name, projectValue('project', p.id))));
    $('repo-options').replaceChildren(...github.repos.map(r => new Option(r.name, projectValue('repo', r.id))));
    select.value = [...select.options].some(o => o.value === previous) ? previous : NO_PROJECT;
    onProjectChange();
}

function selectedIssues() {
    return github.issues.get($('project-select').value) ?? [];
}

async function onProjectChange() {
    const value = $('project-select').value;
    const choice = parseProjectChoice(value);
    const usesIssues = choice.kind !== 'none';
    $('title-group').hidden = usesIssues;
    $('issue-group').hidden = !usesIssues;
    $('new-issue-form').hidden = true;
    setNote('issue-note', '');
    if (!usesIssues) return;

    const select = $('issue-select');
    if (!github.issues.has(value)) {
        select.replaceChildren(new Option('Loading issues…', ''));
        try {
            const issues = choice.kind === 'project'
                ? await githubApi.listProjectIssues(choice.id)
                : await githubApi.listRepoIssues(choice.id);
            github.issues.set(value, issues);
        } catch (error) {
            console.error(error);
            select.replaceChildren(new Option('Error loading issues', ''));
            return;
        }
        if ($('project-select').value !== value) return;  // changed while loading
    }
    renderIssueOptions();
}

function renderIssueOptions(selectedId = '') {
    const issues = selectedIssues();
    $('issue-select').replaceChildren(
        new Option(issues.length ? '-- Choose an issue --' : '-- No open issues --', ''),
        new Option('+ New issue', NEW_ISSUE),
        ...issues.map(i => new Option(issueLabel(i), i.id)),
    );
    $('issue-select').value = selectedId;
    onIssueChange();
}

function selectedIssue() {
    const id = $('issue-select').value;
    return selectedIssues().find(i => i.id === id) ?? null;
}

async function onIssueChange() {
    const value = $('issue-select').value;
    $('new-issue-form').hidden = value !== NEW_ISSUE;
    setNote('issue-note', '');
    if (value === NEW_ISSUE) {
        showNewIssueForm();
        return;
    }
    const issue = selectedIssue();
    if (!issue) return;
    setNote('issue-note', 'Checking hours fields…');
    try {
        const target = await githubLogger.prepare(issue.id);
        if ($('issue-select').value === issue.id) setNote('issue-note', describeTarget(target));
    } catch (error) {
        console.error(error);
        setNote('issue-note', `Couldn't read the issue: ${error.message}`);
    }
}

function showNewIssueForm() {
    const choice = parseProjectChoice($('project-select').value);
    $('new-issue-title').value = '';
    $('new-issue-estimate').value = '';
    setNote('new-issue-status', '');
    const repoSelect = $('new-issue-repo');
    if (choice.kind === 'project') {
        // Issues must live in a repo. Default to where most of this project's issues are.
        const issues = selectedIssues();
        const repos = [...github.repos];
        for (const i of issues) {
            if (!repos.some(r => r.id === i.repoId)) repos.push({ id: i.repoId, name: i.repo });
        }
        repoSelect.replaceChildren(...repos.map(r => new Option(r.name, r.id)));
        repoSelect.value = defaultRepoId(issues, repos) ?? '';
        $('new-issue-repo-group').hidden = false;
        loadCreateInfo(repoSelect.value);
    } else {
        $('new-issue-repo-group').hidden = true;
        loadCreateInfo(choice.id);
    }
    $('new-issue-title').focus();
}

// Fills type, epic and estimate for the chosen repo. Personal repos have none of them.
async function loadCreateInfo(repoId) {
    createInfo = null;
    for (const group of ['new-issue-type-group', 'new-issue-epic-group', 'new-issue-estimate-group']) {
        $(group).hidden = true;
    }
    if (!repoId) return;
    try {
        const info = await githubApi.getRepoCreateInfo(repoId, CREATED_LABEL.name);
        const epics = info.org ? await githubApi.listOrgEpics(info.org) : [];
        if (!$('new-issue-form').hidden && currentNewIssueRepo() !== repoId) return;  // repo changed meanwhile
        createInfo = { ...info, epics };

        if (info.issueTypes.length) {
            $('new-issue-type').replaceChildren(...info.issueTypes.map(t => new Option(t.name, t.id)));
            const task = info.issueTypes.find(t => t.name === DEFAULT_ISSUE_TYPE);
            if (task) $('new-issue-type').value = task.id;
            $('new-issue-type-group').hidden = false;
        }
        if (info.org) {
            $('new-issue-epic').replaceChildren(new Option('-- No epic --', ''),
                ...epics.map(e => new Option(issueLabel(e), e.id)));
            $('new-issue-epic-group').hidden = false;
        }
        $('new-issue-estimate-group').hidden = !estimateField();
    } catch (error) {
        console.error(error);
        setNote('new-issue-status', `Couldn't load repo details: ${error.message}`);
    }
}

function currentNewIssueRepo() {
    const choice = parseProjectChoice($('project-select').value);
    return choice.kind === 'project' ? $('new-issue-repo').value : choice.id;
}

function estimateField() {
    return createInfo?.numberFields.find(f => f.name.toLowerCase() === 'estimated hours') ?? null;
}

async function ensureCreatedLabel() {
    if (createInfo.labelId) return createInfo.labelId;
    createInfo.labelId = await githubApi.createLabel(
        createInfo.repoId, CREATED_LABEL.name, CREATED_LABEL.color, CREATED_LABEL.description);
    return createInfo.labelId;
}

async function createIssue() {
    const title = $('new-issue-title').value.trim();
    if (!title) {
        alert('Please enter an issue title.');
        return;
    }
    if (!createInfo) {
        alert('Still loading the repo details. Try again in a moment.');
        return;
    }
    const choice = parseProjectChoice($('project-select').value);
    const button = $('create-issue-button');
    button.disabled = true;
    setNote('new-issue-status', 'Creating…');
    try {
        const estimate = parseFloat($('new-issue-estimate').value);
        const field = estimateField();
        const issue = await githubApi.createIssue({
            repoId: createInfo.repoId,
            title,
            issueTypeId: $('new-issue-type-group').hidden ? null : $('new-issue-type').value,
            parentIssueId: $('new-issue-epic-group').hidden ? null : $('new-issue-epic').value,
            projectId: choice.kind === 'project' ? choice.id : null,
            labelIds: [await ensureCreatedLabel()],
            assigneeIds: github.viewer ? [github.viewer.id] : [],
            issueFields: field && estimate > 0 ? [{ fieldId: field.id, numberValue: estimate }] : [],
        });
        const key = $('project-select').value;
        github.issues.set(key, [issue, ...(github.issues.get(key) ?? [])]);
        renderIssueOptions(issue.id);
    } catch (error) {
        console.error(error);
        setNote('new-issue-status', `Couldn't create the issue: ${error.message}`);
    } finally {
        button.disabled = false;
    }
}

// What the session logs to: { label, issue } where issue is null for No Project.
// Returns null if an issue is required but not chosen yet.
function chooseLogTarget() {
    if (parseProjectChoice($('project-select').value).kind === 'none') {
        return { label: $('project-input').value.trim(), issue: null };
    }
    const issue = selectedIssue();
    return issue ? { label: issueLabel(issue), issue } : null;
}

// Local totals always get the hours. An issue also gets them on GitHub.
function sessionLogger(issue) {
    return {
        addHours(name, hours) {
            logger.addHours(name, hours);
            if (issue) logToGithub(issue, hours);
        },
    };
}

async function logToGithub(issue, hours) {
    const show = (text) => { $('session-github').textContent = text; };
    show('Updating GitHub…');
    try {
        const result = await githubLogger.log(issue.id, hours, { fresh: !pageHiding });
        if (result.kind === 'comment') show('Posted an hours-worked comment on the issue.');
        else if (result.kind === 'queued') show('GitHub update queued for next time.');
        else show(`${result.fieldName} is now ${result.value} h.`);
    } catch (error) {
        console.error(error);
        show(`GitHub update failed (${error.message}). It will be retried next time.`);
    }
}

// --- tracked session ---

// Runs inside the click handler with nothing awaited before playback.play(),
// so the browser counts the audio as user-initiated.
function startSession() {
    const target = chooseLogTarget();
    if (!target) {
        alert('Choose an issue (or create one) first, or pick No Project.');
        return;
    }
    session = createSession({ project: target.label, logger: sessionLogger(target.issue) });
    sessionLabel = target.label;
    sessionTracks = preview.tracks;
    current = { index: -1, startedAtMs: 0 };
    playing = false;

    $('session-project').textContent = target.label || 'No project (not logging)';
    $('session-github').textContent = '';
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
    // After play(), so nothing is awaited before it. Readies a one-write log for pagehide.
    if (target.issue) githubLogger.prepare(target.issue.id).catch(console.error);
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
    const project = sessionLabel;
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
        pageHiding = true;
        if (session && !session.isFinished()) session.finish();
    });
    $('project-select').addEventListener('change', onProjectChange);
    $('issue-select').addEventListener('change', onIssueChange);
    $('new-issue-repo').addEventListener('change', () => loadCreateInfo($('new-issue-repo').value));
    $('create-issue-button').addEventListener('click', createIssue);
    $('github-save-button').addEventListener('click', saveGithubSettings);
    $('github-clear-button').addEventListener('click', removeGithubToken);
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
    loadGithub();
}

boot();
