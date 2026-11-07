// Pomodorify Spotless: the track app with YouTube in place of Spotify.
//
// One page, two screens:
//   home: four stacked panels. Pomo (pick a playlist and a task, start and
//         control a session), Playlist (make one: Search or List), Tasks
//         (logged time, Export, Clear) and Settings.
//   playlist: one saved playlist (rename, delete, tracks, labels, start).
// Popups (<dialog>) for Search, List, Export, Clear and Settings.
//
// Session timing, the local and GitHub loggers, totals export and the GitHub
// pickers are imported read-only from ../track/ (they're platform-neutral).
// Nothing here writes to the track app's files.

import { formatDuration, selectTracksForDuration } from '../utils.js';
import { createLocalLogger } from '../track/loggers/local.js';
import { createSession, formatClock, remainingMs } from '../track/session.js';
import { totalsToCsv, totalsToJson, describeTotals } from '../track/export.js';
import { createGithubSettings } from '../track/github/settings.js';
import { createGithubApi } from '../track/github/api.js';
import { describeTarget } from '../track/github/hours-target.js';
import { createGithubLogger } from '../track/loggers/github.js';
import {
    NO_PROJECT, NEW_ISSUE, DEFAULT_ISSUE_TYPE,
    parseProjectChoice, projectValue, issueLabel, defaultRepoId,
} from '../track/github/picker.js';
import { createYoutubeSettings } from './settings.js';
import { createYoutubeApi, describeSearchOptions } from './youtube-api.js';
import { createPlaylistStore } from './playlists.js';
import { createYoutubePlayback } from './playback/youtube.js';
import { buildPlaylist, parseLines, cachedSearch, fetchSpotifyTitle } from './build.js';
import { parseLabels, fetchIssueLabels, formatLabelCounts } from './labels.js';

const BACKGROUNDS = [
    '../assets/tta_icetroid.jpg',
    '../assets/robots.jpeg',
    '../assets/ringscape.jpeg',
    '../assets/suits.jpeg',
    '../assets/redcity.jpeg',
    '../assets/tta_city.jpg',
    '../assets/tta_city2.jpg',
];

const SCREENS = ['key-screen', 'home-screen', 'playlist-screen'];

// U+FE0E asks for the plain glyph, not a colour emoji.
const CONTROLS = [
    { action: 'prev', label: '⏮︎', title: 'Previous track' },
    { action: 'toggle', label: '⏸︎', title: 'Pause' },
    { action: 'stop', label: '⏹︎', title: 'Stop' },
    { action: 'next', label: '⏭︎', title: 'Next track' },
];

const $ = (id) => document.getElementById(id);

const youtubeSettings = createYoutubeSettings();
const youtubeApi = createYoutubeApi(youtubeSettings.getKey);
const playlists = createPlaylistStore();
const playback = createYoutubePlayback({ element: 'player' });
const logger = createLocalLogger();
const searchSong = cachedSearch((query) => youtubeApi.searchSong(query));

const CREATED_LABEL = { name: 'pomodorify created', color: 'e4572e', description: 'Created from Pomodorify' };
const githubSettings = createGithubSettings();
const githubApi = createGithubApi(githubSettings.getToken);
const githubLogger = createGithubLogger({ api: githubApi, getFieldNames: githubSettings.getFieldNames });

// GitHub lists, loaded once a token is set. issues: cache keyed by Project choice value.
let github = { viewer: null, repos: [], projects: [], issues: new Map() };
let createInfo = null;     // getRepoCreateInfo() for the new-issue form's repo
let pageHiding = false;    // set on pagehide so the GitHub write uses keepalive

let selectedId = null;     // the playlist chosen in the Pomo panel
let viewedId = null;       // the playlist on the playlist screen
let playerReady = false;
let playerStarting = false;

let session = null;
let sessionLabel = '';     // what the session logs to (title or issue label)
let sessionTracks = [];
let runningId = null;      // the playlist being played
let current = { index: -1, startedAtMs: 0 };  // track position, in session-clock time
let playing = false;
let ticker = null;

// Labels: an issue's labels, fetched when it's chosen, and the session's.
const issueLabels = new Map();  // issue id -> label names
let sessionPlaylistId = null;
let sessionLabels = null;       // names, or a promise while an issue's are loading

// --- screens ---

function showScreen(id) {
    for (const screen of SCREENS) $(screen).hidden = screen !== id;
    window.scrollTo(0, 0);
}

const isRunning = () => Boolean(session && !session.isFinished());

function setRandomBackground() {
    const bg = BACKGROUNDS[Math.floor(Math.random() * BACKGROUNDS.length)];
    $('bg').style.backgroundImage =
        `linear-gradient(rgba(25, 25, 35, 0.4), rgba(25, 25, 35, 0.4)), url('${bg}')`;
}

function setNote(id, text) {
    $(id).textContent = text || '';
    $(id).hidden = !text;
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function totalMs(tracks) {
    return tracks.reduce((sum, t) => sum + t.duration_ms, 0);
}

function minutesSetting() {
    return parseInt($('duration').value, 10) || 25;
}

function today() {
    return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// --- Pomo panel: playlist choice and Start ---

// Saved playlists, newest first. Keeps the current choice, else the newest.
function renderPlaylists() {
    const list = playlists.list();
    if (!list.some(p => p.id === selectedId)) selectedId = list[0]?.id ?? null;
    $('replay-select').replaceChildren(...list.map(p =>
        new Option(`${p.name} (${formatDuration(totalMs(p.tracks))})`, p.id)));
    $('replay-select').value = selectedId ?? '';
    $('replay-select').hidden = list.length === 0;
    $('view-button').hidden = list.length === 0;
    $('no-playlists-note').hidden = list.length > 0;
    renderStartButtons();
}

function renderStartButtons() {
    $('start-button').disabled = !(playerReady && selectedId && !isRunning());
    $('playlist-start-button').disabled = !(playerReady && viewedId && !isRunning());
}

// --- playlist screen ---

function sourceText(p) {
    if (p.source?.kind === 'search') return `Search “${p.source.query}” · ${describeSearchOptions(p.source.options)}`;
    if (p.source?.kind === 'list') return 'List';
    return p.query ? `Search “${p.query}”` : '—';
}

function trackRow(track, index) {
    const row = el('div', 'track-item');
    if (viewedId === runningId && isRunning() && index === current.index) row.classList.add('current');
    const info = el('div', 'track-info');
    const name = el('div', 'track-name');
    name.append(videoLink(track));
    info.append(name, el('div', 'track-artist', track.artist));
    row.append(info, el('div', 'track-duration', formatDuration(track.duration_ms)));
    return row;
}

function openPlaylist(id) {
    viewedId = id;
    renderPlaylistScreen();
    showScreen('playlist-screen');
}

function renderPlaylistScreen() {
    const p = playlists.get(viewedId);
    if (!p) return;
    $('playlist-name').value = p.name;
    $('playlist-source').textContent = sourceText(p);
    $('playlist-length').textContent = formatDuration(totalMs(p.tracks));
    $('playlist-count').textContent = String(p.tracks.length);
    const labels = formatLabelCounts(p.labels);
    $('playlist-labels-list').textContent = labels;
    $('playlist-labels').hidden = !labels;
    $('playlist-tracks').replaceChildren(...p.tracks.map(trackRow));

    const playingThis = isRunning() && runningId === p.id;
    $('playlist-controls').hidden = !playingThis;
    $('playlist-actions').hidden = playingThis;
    $('playlist-task').textContent = playingThis ? loggingText(sessionTarget)
        : isRunning() ? 'Another playlist is playing.'
            : loggingText(chooseLogTarget(), true);
    renderStartButtons();
}

function renamePlaylist() {
    const name = $('playlist-name').value.trim();
    if (!name) return;
    playlists.rename(viewedId, name);
    renderPlaylists();
    renderPlaylistScreen();
}

function deletePlaylist() {
    const p = playlists.get(viewedId);
    if (!p) return;
    if (isRunning() && runningId === p.id) {
        alert('Stop the session first.');
        return;
    }
    if (!confirm(`Delete the playlist "${p.name}"? Logged time isn't affected.`)) return;
    playlists.remove(p.id);
    viewedId = null;
    renderPlaylists();
    showScreen('home-screen');
}

// --- Search popup ---

function readSearchOptions() {
    return {
        minMinutes: parseFloat($('search-min').value),
        maxMinutes: parseFloat($('search-max').value),
        instrumental: $('opt-instrumental').checked,
        explicit: $('opt-explicit').checked,
        official: $('opt-official').checked,
        noLive: $('opt-nolive').checked,
        noCovers: $('opt-nocovers').checked,
    };
}

// Keeps shortest <= longest, moving the other slider.
function syncSliders(changed) {
    const min = $('search-min');
    const max = $('search-max');
    if (parseFloat(min.value) > parseFloat(max.value)) {
        if (changed === min) max.value = min.value;
        else min.value = max.value;
    }
    $('search-min-value').textContent = min.value;
    $('search-max-value').textContent = max.value;
}

function openSearch() {
    syncSliders();
    setNote('search-status', '');
    $('search-create-button').disabled = false;
    $('search-dialog').showModal();
    $('search-input').focus();
}

// Searches YouTube, fits the results to the Minutes setting, saves the
// playlist and opens it. One search is 101-404 of the daily quota units.
async function createSearch() {
    const query = $('search-input').value.trim();
    if (!query) {
        setNote('search-status', 'Please enter a search.');
        return;
    }
    const minutes = minutesSetting();
    const options = readSearchOptions();
    const button = $('search-create-button');
    button.disabled = true;
    setNote('search-status', 'Searching…');
    try {
        const found = await youtubeApi.searchTracks(query, options);
        if (found.length === 0) {
            setNote('search-status', 'No playable videos found. Try another search or a wider length range.');
            return;
        }
        const saved = playlists.save({
            name: $('search-name').value.trim() || `${query} · ${minutes} min · ${today()}`,
            query,
            minutes,
            tracks: selectTracksForDuration(found, minutes),
            source: { kind: 'search', query, options },
        });
        $('search-dialog').close();
        $('search-name').value = '';
        selectedId = saved.id;
        renderPlaylists();
        openPlaylist(saved.id);
    } catch (error) {
        console.error(error);
        setNote('search-status', `YouTube search failed: ${error.message}`);
    } finally {
        button.disabled = false;
    }
}

// --- List popup (build from a list) ---

let built = null;  // the playlist the last build saved

function openBuild() {
    $('build-input').hidden = false;
    $('build-output').hidden = true;
    $('build-duration-note').textContent = `Fits to ${minutesSetting()} minutes (the Minutes setting): lines are picked at random `
        + 'and only the ones needed are searched. Each search uses about 1% of the day\'s shared YouTube quota.';
    $('build-dialog').showModal();
    $('build-title').focus();
}

function videoLink(track) {
    const a = el('a', '', track.name);
    a.href = `https://www.youtube.com/watch?v=${encodeURIComponent(track.id)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
}

function trackItem(track, prefix = '') {
    const li = el('li');
    if (prefix) li.append(prefix);
    li.append(videoLink(track), ` — ${track.artist} (${formatDuration(track.duration_ms)})`);
    return li;
}

function renderLogEntry(entry) {
    const li = el('li');
    const steps = el('ul');
    if (entry.kind === 'line') {
        li.append(el('div', 'line', entry.line));
        if (entry.spotify) steps.append(el('li', '', `Spotify link → “${entry.spotify}”`));
        if (entry.query) {
            const searched = el('li', '', 'Searched ');
            searched.append(el('code', '', entry.query));
            if (entry.cached) searched.append(el('span', 'muted', ' (cached, no quota used)'));
            steps.append(searched);
        }
        for (const r of entry.rejected) steps.append(el('li', 'skip', `Skipped “${r.name}”: ${r.reason}`));
        if (entry.pick) steps.append(trackItem(entry.pick, 'Picked '));
        else if (entry.error) steps.append(el('li', 'fail', `Failed: ${entry.error}. Line skipped.`));
        else steps.append(el('li', 'fail', 'Nothing usable found. Line skipped.'));
    } else if (entry.kind === 'unused') {
        const details = el('details', 'muted');
        details.append(el('summary', '', `${entry.count} line${entry.count === 1 ? '' : 's'} not needed this time`));
        const list = el('ul');
        for (const line of entry.lines) list.append(el('li', '', line));
        details.append(list);
        li.append(details);
    } else if (entry.source === 'results') {
        li.append(el('div', 'line', 'Not long enough yet: filled from the other results of these searches'));
        for (const t of entry.picks) steps.append(trackItem(t));
        if (entry.picks.length === 0) steps.append(el('li', 'muted', 'None left to use.'));
    } else {
        li.append(el('div', 'line', 'Still not long enough: random instrumental bluegrass'));
        const searched = el('li', '', 'Searched ');
        searched.append(el('code', '', entry.query));
        steps.append(searched);
        for (const t of entry.picks) steps.append(trackItem(t));
        if (entry.error) steps.append(el('li', 'fail', `Failed: ${entry.error}`));
        else if (entry.picks.length === 0) steps.append(el('li', 'fail', 'Nothing usable found.'));
    }
    li.append(steps);
    return li;
}

// YouTube makes an unsaved playlist from up to 50 video ids.
function youtubeListUrl(tracks) {
    return `https://www.youtube.com/watch_videos?video_ids=${tracks.slice(0, 50).map(t => t.id).join(',')}`;
}

async function createBuild() {
    const lines = parseLines($('build-lines').value);
    if (lines.length === 0) {
        alert('Please enter at least one song.');
        return;
    }
    const minutes = minutesSetting();
    const title = $('build-title').value.trim() || `List · ${minutes} min · ${today()}`;

    $('build-input').hidden = true;
    $('build-output').hidden = false;
    $('build-log').replaceChildren();
    $('build-result').hidden = true;
    $('build-show-button').hidden = true;
    $('build-close-button').disabled = true;
    $('build-status').textContent = `Building “${title}” (${minutes} min) from ${lines.length} line${lines.length === 1 ? '' : 's'}…`;
    built = null;

    try {
        const { tracks, totalMs: length } = await buildPlaylist({
            lines,
            minutes,
            searchSong,
            spotifyTitle: (id) => fetchSpotifyTitle(id),
            onLog: (entry) => $('build-log').append(renderLogEntry(entry)),
        });
        const result = $('build-result');
        result.replaceChildren();
        if (tracks.length === 0) {
            result.append(el('p', 'fail', 'Nothing usable was found, so nothing was saved.'));
        } else {
            built = playlists.save({ name: title, minutes, tracks, source: { kind: 'list' } });
            selectedId = built.id;
            renderPlaylists();
            const saved = el('p');
            saved.append('Saved ', el('strong', '', `“${built.name}”`),
                ` · ${tracks.length} tracks · ${formatDuration(length)}`);
            const link = el('a', '', 'Open it on YouTube');
            link.href = youtubeListUrl(tracks);
            link.target = '_blank';
            link.rel = 'noopener';
            result.append(saved, link);
            $('build-show-button').hidden = false;
        }
        result.hidden = false;
        $('build-status').textContent = 'Done. Here\'s what happened:';
    } catch (error) {
        console.error(error);
        $('build-status').textContent = error.reason === 'quotaExceeded'
            ? 'Stopped: the YouTube search quota for today is used up. Nothing was saved. Try again tomorrow.'
            : `Stopped: ${error.message}. Nothing was saved.`;
    } finally {
        $('build-close-button').disabled = false;
    }
}

function showBuilt() {
    $('build-dialog').close();
    if (built) openPlaylist(built.id);
}

// --- Tasks panel: logged time, Export, Clear ---

function renderTotals() {
    const totals = logger.getTotals();
    const projects = Object.keys(totals).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    $('totals-empty').hidden = projects.length > 0;
    $('totals-body').replaceChildren(...projects.map((project) => {
        const row = el('tr');
        row.append(el('td', '', project), el('td', '', totals[project].toFixed(2)));
        return row;
    }));
    $('project-list').replaceChildren(...projects.map(p => new Option(p)));
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

function hasTotals() {
    return Object.keys(logger.getTotals()).length > 0;
}

function openExport() {
    $('export-summary').textContent = hasTotals() ? `${describeTotals(logger.getTotals())}.` : 'Nothing logged yet.';
    $('export-download-button').disabled = !hasTotals();
    $('export-dialog').showModal();
}

function exportTotals() {
    const format = document.querySelector('input[name="export-format"]:checked').value;
    const totals = logger.getTotals();
    if (format === 'json') download('pomodorify-hours.json', totalsToJson(totals), 'application/json');
    else download('pomodorify-hours.csv', totalsToCsv(totals), 'text/csv');
    $('export-dialog').close();
}

function openClear() {
    $('clear-summary').textContent = hasTotals() ? `Delete ${describeTotals(logger.getTotals())}?` : 'Nothing logged yet.';
    $('clear-confirm-button').disabled = !hasTotals();
    $('clear-dialog').showModal();
}

function clearTotals() {
    logger.clear();
    renderTotals();
    $('clear-dialog').close();
}

// --- Settings popup ---

function openSettings() {
    renderGithubSettings();
    renderKeyStatus();
    setNote('playlists-status', '');
    $('settings-dialog').showModal();
}

function exportPlaylists() {
    download('spotless-playlists.json', playlists.exportJson(), 'application/json');
}

async function importPlaylists(event) {
    const file = event.target.files[0];
    event.target.value = '';  // so picking the same file again still fires `change`
    if (!file) return;
    try {
        const added = playlists.importJson(await file.text());
        setNote('playlists-status', `Loaded ${added} playlist${added === 1 ? '' : 's'}.`);
        renderPlaylists();
    } catch (error) {
        console.error(error);
        setNote('playlists-status', `Couldn't load that file: ${error.message}`);
    }
}

function showKeyScreen() {
    $('key-input').value = '';
    showScreen('key-screen');
}

function renderKeyStatus() {
    $('key-status').textContent = youtubeSettings.hasPastedKey() ? 'Using the key you pasted.'
        : youtubeSettings.getKey() ? 'Using the built-in key.' : 'No key set.';
    $('key-change-input').value = '';
}

function saveKey(input) {
    const key = $(input).value.trim();
    if (!key) {
        alert('Please paste a YouTube Data API key.');
        return;
    }
    youtubeSettings.setKey(key);
    renderKeyStatus();
    if (!$('key-screen').hidden) enterApp();
}

function removeKey() {
    youtubeSettings.clearKey();
    renderKeyStatus();
    if (!youtubeSettings.getKey()) {
        $('settings-dialog').close();
        showKeyScreen();
    }
}

// --- GitHub: settings, Project/issue pickers, new issue ---

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
        setNote('github-note', 'Add a GitHub token in Settings to log time to issues.');
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
    $('labels-group').hidden = usesIssues;
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
        const [target, labels] = await Promise.all([githubLogger.prepare(issue.id), labelsForIssue(issue.id)]);
        const labelText = labels.length ? ` Labels: ${labels.join(', ')}.` : ' No labels.';
        if ($('issue-select').value === issue.id) setNote('issue-note', describeTarget(target) + labelText);
    } catch (error) {
        console.error(error);
        setNote('issue-note', `Couldn't read the issue: ${error.message}`);
    }
}

// Cached per issue for the page's lifetime.
async function labelsForIssue(issueId) {
    if (!issueLabels.has(issueId)) issueLabels.set(issueId, await fetchIssueLabels(githubApi, issueId));
    return issueLabels.get(issueId);
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

let sessionTarget = null;  // chooseLogTarget() at start, plus the labels typed

// "Logging to: X · labels: a, b" (#20). `before` words it for a session not started yet.
function loggingText(target, before = false) {
    if (!target) return 'Choose an issue on the home screen, or No Project.';
    if (!target.label) return before ? 'Not logging: no task title set.' : 'Not logging (no task title).';
    const labels = target.issue ? (issueLabels.get(target.issue.id) ?? []) : (target.labels ?? []);
    return `${before ? 'Will log to' : 'Logging to'}: ${target.label}${labels.length ? ` · labels: ${labels.join(', ')}` : ''}`;
}

function buildControls() {
    for (const container of document.querySelectorAll('[data-controls]')) {
        container.replaceChildren(...CONTROLS.map(({ action, label, title }) => {
            const button = el('button', '', label);
            button.dataset.action = action;
            button.title = title;
            button.setAttribute('aria-label', title);
            button.addEventListener('click', () => control(action));
            return button;
        }));
    }
}

function renderControls() {
    for (const button of document.querySelectorAll('[data-action="toggle"]')) {
        button.textContent = playing ? '⏸︎' : '▶︎';
        button.title = playing ? 'Pause' : 'Resume';
        button.setAttribute('aria-label', button.title);
    }
}

function control(action) {
    if (!isRunning()) return;
    if (action === 'toggle') (playing ? playback.pause() : playback.resume()).catch(console.error);
    else if (action === 'stop') stopSession();
    else if (action === 'next') playback.next().catch(console.error);
    else if (action === 'prev') playback.previous().catch(console.error);
}

// Runs inside the click handler with nothing awaited before playback.play(),
// so the browser counts the audio as user-initiated.
function startSession(playlistId) {
    const playlist = playlists.get(playlistId);
    if (!playlist || !playerReady || isRunning()) return;
    const target = chooseLogTarget();
    if (!target) {
        alert('Choose an issue (or create one) first, or pick No Project.');
        return;
    }
    if (!target.issue) target.labels = parseLabels($('labels-input').value);
    session = createSession({ project: target.label, logger: sessionLogger(target.issue) });
    sessionTarget = target;
    sessionLabel = target.label;
    sessionPlaylistId = playlist.id;
    sessionLabels = target.issue
        ? (issueLabels.get(target.issue.id) ?? null)  // fetched below if not loaded yet
        : target.labels;
    sessionTracks = playlist.tracks;
    runningId = playlist.id;
    current = { index: -1, startedAtMs: 0 };
    playing = false;

    $('running-task').textContent = loggingText(target);
    $('session-github').textContent = '';
    $('session-track-name').textContent = 'Starting…';
    $('session-track-artist').textContent = '';
    $('pomo-setup').hidden = true;
    $('pomo-running').hidden = false;
    document.querySelector('#pomo-running [data-controls]').hidden = false;
    $('running-view-button').hidden = false;
    $('session-done').hidden = true;
    $('player-wrap').classList.remove('parked');
    renderControls();
    renderSession();
    if (viewedId) renderPlaylistScreen();
    ticker = setInterval(renderSession, 500);

    playback.play(sessionTracks).catch((error) => {
        console.error(error);
        alert('Failed to start playback. Please try again.');
        endSession();
    });
    // After play(), so nothing is awaited before it. Readies a one-write log for pagehide.
    if (target.issue) githubLogger.prepare(target.issue.id).catch(console.error);
    if (sessionLabels === null) {
        sessionLabels = labelsForIssue(target.issue.id).catch((error) => {
            console.error(error);
            return [];
        });
    }
}

// Counts the session's labels against its playlist, if anything played.
// Synchronous when the labels are already known, so it works on pagehide.
function recordSessionLabels() {
    const playlistId = sessionPlaylistId;
    const labels = sessionLabels;
    sessionPlaylistId = null;
    if (!playlistId || !(session.elapsedMs() > 0)) return;
    const record = (names) => {
        if (names.length === 0) return;
        playlists.addLabels(playlistId, names);
        $('session-labels').textContent = `Playlist labels +1: ${names.join(', ')}`;
        $('session-labels').hidden = false;
        if (viewedId === playlistId) renderPlaylistScreen();
    };
    if (Array.isArray(labels)) record(labels);
    else labels?.then(record);
}

function finishSession() {
    const hours = session.finish();
    recordSessionLabels();
    return hours;
}

function onPlaybackChange(change) {
    if (!isRunning()) return;
    session.setPlaying(change.playing);
    playing = change.playing;
    renderControls();

    if (change.trackIndex !== current.index && change.trackIndex >= 0) {
        current = { index: change.trackIndex, startedAtMs: session.elapsedMs() };
        const track = sessionTracks[change.trackIndex];
        $('session-track-name').textContent = track.name;
        $('session-track-artist').textContent = track.artist;
        if (viewedId === runningId) renderPlaylistScreen();
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
    if (!isRunning()) return;
    renderSession();
    const project = sessionLabel;
    $('session-labels').hidden = true;
    const hours = finishSession();
    clearInterval(ticker);
    ticker = null;

    document.querySelector('#pomo-running [data-controls]').hidden = true;
    $('running-view-button').hidden = true;
    $('session-done').hidden = false;
    $('session-progress').textContent = '';
    $('player-wrap').classList.add('parked');
    $('session-summary').textContent = hours > 0
        ? `Logged ${hours.toFixed(2)} h to ${project}.`
        : project ? 'Nothing played, so nothing was logged.' : 'No task title, so nothing was logged.';
    $('running-task').textContent = project ? `Task: ${project}` : '';
    renderTotals();
    renderStartButtons();
    if (viewedId) renderPlaylistScreen();
}

function stopSession() {
    endSession();
    playback.stop().catch(console.error);
}

function closeSession() {
    $('pomo-running').hidden = true;
    $('pomo-setup').hidden = false;
}

// --- setup ---

// The player is created once, before any click, so Start can play inside the
// click handler. It sits parked off-screen until a session shows it.
async function setUpPlayer() {
    if (playerReady || playerStarting) return;
    playerStarting = true;
    setNote('player-note', 'Loading the YouTube player…');
    try {
        await playback.init();
        playerReady = true;
        setNote('player-note', '');
    } catch (error) {
        console.error('YouTube player failed to start:', error);
        setNote('player-note', `Playback unavailable: ${error.message}`);
    } finally {
        playerStarting = false;
        renderStartButtons();
    }
}

function wireEvents() {
    const on = (id, event, fn) => $(id).addEventListener(event, fn);
    const click = (id, fn) => on(id, 'click', fn);
    const enter = (id, fn) => on(id, 'keydown', (e) => { if (e.key === 'Enter') fn(); });

    click('key-save-button', () => saveKey('key-input'));
    enter('key-input', () => saveKey('key-input'));

    // Pomo
    on('replay-select', 'change', () => {
        selectedId = $('replay-select').value || null;
        renderStartButtons();
    });
    click('view-button', () => { if (selectedId) openPlaylist(selectedId); });
    click('start-button', () => startSession(selectedId));
    click('new-session-button', closeSession);
    click('running-view-button', () => { if (runningId) openPlaylist(runningId); });
    on('project-select', 'change', onProjectChange);
    on('issue-select', 'change', onIssueChange);
    on('new-issue-repo', 'change', () => loadCreateInfo($('new-issue-repo').value));
    click('create-issue-button', createIssue);

    // Playlist screen
    click('playlist-back-button', () => {
        viewedId = null;
        showScreen('home-screen');
    });
    click('rename-button', renamePlaylist);
    enter('playlist-name', renamePlaylist);
    click('playlist-start-button', () => startSession(viewedId));
    click('delete-button', deletePlaylist);

    // Playlist panel and its popups
    click('search-open-button', openSearch);
    click('search-cancel-button', () => $('search-dialog').close());
    click('search-create-button', createSearch);
    enter('search-input', createSearch);
    on('search-min', 'input', () => syncSliders($('search-min')));
    on('search-max', 'input', () => syncSliders($('search-max')));
    click('build-open-button', openBuild);
    click('build-cancel-button', () => $('build-dialog').close());
    click('build-create-button', createBuild);
    click('build-close-button', () => $('build-dialog').close());
    click('build-show-button', showBuilt);
    // Esc closes a dialog; don't let it while a build is running.
    on('build-dialog', 'cancel', (e) => { if ($('build-close-button').disabled && !$('build-output').hidden) e.preventDefault(); });

    // Tasks panel and its popups
    click('export-open-button', openExport);
    click('export-cancel-button', () => $('export-dialog').close());
    click('export-download-button', exportTotals);
    click('clear-open-button', openClear);
    click('clear-cancel-button', () => $('clear-dialog').close());
    click('clear-confirm-button', clearTotals);

    // Settings
    click('settings-open-button', openSettings);
    click('settings-close-button', () => $('settings-dialog').close());
    click('github-save-button', saveGithubSettings);
    click('github-clear-button', removeGithubToken);
    click('key-change-button', () => saveKey('key-change-input'));
    click('key-remove-button', removeKey);
    click('export-playlists-button', exportPlaylists);
    click('import-playlists-button', () => $('import-playlists-file').click());
    on('import-playlists-file', 'change', importPlaylists);

    playback.onStateChange(onPlaybackChange);
    // Closing the tab mid-session still logs the time played so far.
    window.addEventListener('pagehide', () => {
        pageHiding = true;
        if (isRunning()) finishSession();
    });
}

function enterApp() {
    showScreen('home-screen');
    renderTotals();
    renderPlaylists();
    setUpPlayer();
    if (!github.viewer) loadGithub();
}

function boot() {
    setRandomBackground();
    buildControls();
    wireEvents();
    if (youtubeSettings.getKey()) enterApp();
    else showKeyScreen();
}

boot();
