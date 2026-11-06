// Pomodorify Spotless: the track app with YouTube in place of Spotify. Search
// YouTube, fit the results to a duration, name and keep the playlist in this
// browser, play it in the tab and log the time actually played.
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
import { createYoutubeApi } from './youtube-api.js';
import { createPlaylistStore } from './playlists.js';
import { createYoutubePlayback } from './playback/youtube.js';
import { buildPlaylist, parseLines, cachedSearch, fetchSpotifyTitle } from './build.js';

const BACKGROUNDS = [
    '../assets/tta_icetroid.jpg',
    '../assets/robots.jpeg',
    '../assets/ringscape.jpeg',
    '../assets/suits.jpeg',
    '../assets/redcity.jpeg',
    '../assets/tta_city.jpg',
    '../assets/tta_city2.jpg',
];

const SECTIONS = ['key-section', 'playlist-section', 'preview-section', 'session-section'];

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

let preview = null;        // { tracks, sourceName, query, minutes, savedId }
let playerReady = false;
let playerStarting = false;
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
    $('player-wrap').classList.toggle('parked', id !== 'session-section');
}

function setRandomBackground() {
    const bg = BACKGROUNDS[Math.floor(Math.random() * BACKGROUNDS.length)];
    $('bg').style.backgroundImage =
        `linear-gradient(rgba(25, 25, 35, 0.4), rgba(25, 25, 35, 0.4)), url('${bg}')`;
}

// --- playlist builder ---

// Saved playlists, newest first.
function renderReplays() {
    const list = playlists.list();
    const select = $('replay-select');
    select.replaceChildren(new Option('-- Choose a playlist --', ''));
    for (const p of list) select.add(new Option(`${p.name} (${formatDuration(totalMs(p.tracks))})`, p.id));
    $('replay-group').hidden = list.length === 0;
}

function totalMs(tracks) {
    return tracks.reduce((sum, t) => sum + t.duration_ms, 0);
}

// A saved playlist plays exactly as saved: in order, no shuffle, no fitting.
function replay() {
    const select = $('replay-select');
    const playlist = playlists.get(select.value);
    select.value = '';  // so choosing the same one again still fires `change`
    if (!playlist) return;
    preview = {
        tracks: playlist.tracks,
        sourceName: playlist.query ? `search: ${playlist.query}` : playlist.name,
        query: playlist.query,
        minutes: playlist.minutes,
        savedId: playlist.id,
        name: playlist.name,
    };
    renderPreview();
    showSection('preview-section');
}

function setNote(id, text) {
    $(id).textContent = text || '';
    $(id).hidden = !text;
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

function defaultName(query, minutes) {
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${query} · ${minutes} min · ${date}`;
}

// Searches again each time (REBUILD too), so a rebuild can pick up new videos.
// One search costs ~101 of the key's 10,000 daily quota units.
async function generate() {
    const query = $('search-input').value.trim();
    const minutes = parseInt($('duration').value, 10);

    if (!query) {
        alert('Please enter a search.');
        return;
    }
    if (!(minutes > 0)) {
        alert('Please enter a duration in minutes.');
        return;
    }

    const button = $('generate-button');
    button.disabled = true;
    try {
        const tracks = await youtubeApi.searchTracks(query);
        if (tracks.length === 0) {
            alert('No playable videos found. Try another search.');
            return;
        }
        preview = {
            tracks: selectTracksForDuration(tracks, minutes),
            sourceName: `search: ${query}`,
            query,
            minutes,
            savedId: null,
            name: defaultName(query, minutes),
        };
        renderPreview();
        showSection('preview-section');
    } catch (error) {
        console.error(error);
        alert(`YouTube search failed: ${error.message}`);
        if (error.reason === 'keyInvalid' || /API key/i.test(error.message)) showKeySection();
    } finally {
        button.disabled = false;
    }
}

function trackRow(track) {
    const row = document.createElement('div');
    row.className = 'track-item';
    const info = document.createElement('div');
    info.className = 'track-info';
    const name = document.createElement('div');
    name.className = 'track-name';
    const link = document.createElement('a');
    link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(track.id)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = track.name;
    name.append(link);
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
    $('preview-source-name').textContent = preview.sourceName;
    $('preview-duration').textContent = formatDuration(totalMs(preview.tracks));
    $('preview-track-count').textContent = String(preview.tracks.length);
    $('preview-tracks').replaceChildren(...preview.tracks.map(trackRow));
    $('preview-playlist-name').value = preview.name;
    // REBUILD would only reshuffle a fixed playlist.
    $('regenerate-button').hidden = Boolean(preview.savedId);
    $('delete-button').hidden = !preview.savedId;
    setNote('save-note', preview.savedId ? 'Saved in this browser.' : 'Not saved yet. Starting a session saves it.');
    $('project-list').replaceChildren(...Object.keys(logger.getTotals()).sort().map(p => new Option(p)));
}

// --- saved playlists ---

// Saves a new playlist, or renames a saved one. Synchronous (localStorage), so
// startSession can call it without awaiting before playback.
function savePreview() {
    const name = $('preview-playlist-name').value.trim() || defaultName(preview.query, preview.minutes);
    if (preview.savedId) {
        playlists.rename(preview.savedId, name);
    } else {
        const saved = playlists.save({ name, query: preview.query, minutes: preview.minutes, tracks: preview.tracks });
        preview.savedId = saved.id;
    }
    preview.name = name;
    $('preview-playlist-name').value = name;
    $('regenerate-button').hidden = true;
    $('delete-button').hidden = false;
    setNote('save-note', 'Saved in this browser.');
    renderReplays();
}

function deletePreview() {
    if (!preview?.savedId) return;
    if (!confirm(`Delete the playlist "${preview.name}"? Logged time isn't affected.`)) return;
    playlists.remove(preview.savedId);
    renderReplays();
    showSection('playlist-section');
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
        setNote('playlists-status', `Imported ${added} playlist${added === 1 ? '' : 's'}.`);
        renderReplays();
    } catch (error) {
        console.error(error);
        setNote('playlists-status', `Couldn't import that file: ${error.message}`);
    }
}

// --- build from a list ---

let built = null;  // the playlist the last build saved

function openBuild() {
    const minutes = parseInt($('duration').value, 10) || 25;
    $('build-input').hidden = false;
    $('build-output').hidden = true;
    $('build-duration-note').textContent = `Fits to ${minutes} minutes (the Duration setting): lines are picked at random `
        + 'and only the ones needed are searched. Each search uses about 1% of the day\'s shared YouTube quota.';
    $('build-dialog').showModal();
    $('build-title').focus();
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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
    const minutes = parseInt($('duration').value, 10) || 25;
    const title = $('build-title').value.trim() || `List · ${minutes} min · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

    $('build-input').hidden = true;
    $('build-output').hidden = false;
    $('build-log').replaceChildren();
    $('build-result').hidden = true;
    $('build-show-button').hidden = true;
    $('build-close-button').disabled = true;
    $('build-status').textContent = `Building “${title}” (${minutes} min) from ${lines.length} line${lines.length === 1 ? '' : 's'}…`;
    built = null;

    try {
        const { tracks, totalMs } = await buildPlaylist({
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
            built = playlists.save({ name: title, minutes, tracks });
            renderReplays();
            const saved = el('p');
            saved.append('Saved ', el('strong', '', `“${built.name}”`),
                ` · ${tracks.length} tracks · ${formatDuration(totalMs)}`);
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
    if (!built) return;
    $('replay-select').value = built.id;
    replay();
}

// --- YouTube key ---

function showKeySection() {
    $('key-input').value = '';
    showSection('key-section');
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
    enterApp();
}

function removeKey() {
    youtubeSettings.clearKey();
    if (!youtubeSettings.getKey()) showKeySection();
    renderKeyStatus();
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
    if (!preview.savedId) savePreview();  // sync, so nothing is awaited before play()
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

// The player is created once, before any click, so Start can play inside the
// click handler. It sits parked off-screen until a session shows it.
async function setUpPlayer() {
    if (playerReady || playerStarting) return;
    playerStarting = true;
    setNote('player-note', 'Loading the YouTube player…');
    try {
        await playback.init();
        playerReady = true;
        $('start-button').disabled = false;
        setNote('player-note', '');
    } catch (error) {
        console.error('YouTube player failed to start:', error);
        setNote('player-note', `Playback unavailable: ${error.message}`);
    } finally {
        playerStarting = false;
    }
}

function wireEvents() {
    $('key-save-button').addEventListener('click', () => saveKey('key-input'));
    $('key-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') saveKey('key-input'); });
    $('key-change-button').addEventListener('click', () => saveKey('key-change-input'));
    $('key-remove-button').addEventListener('click', removeKey);
    $('generate-button').addEventListener('click', generate);
    $('search-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') generate(); });
    $('back-button').addEventListener('click', () => showSection('playlist-section'));
    $('regenerate-button').addEventListener('click', generate);
    $('start-button').addEventListener('click', () => { if (playerReady && preview) startSession(); });
    $('build-open-button').addEventListener('click', openBuild);
    $('build-cancel-button').addEventListener('click', () => $('build-dialog').close());
    $('build-create-button').addEventListener('click', createBuild);
    $('build-close-button').addEventListener('click', () => $('build-dialog').close());
    $('build-show-button').addEventListener('click', showBuilt);
    // Esc closes the dialog; don't let it while a build is running.
    $('build-dialog').addEventListener('cancel', (e) => { if ($('build-close-button').disabled && !$('build-output').hidden) e.preventDefault(); });
    $('save-button').addEventListener('click', savePreview);
    $('delete-button').addEventListener('click', deletePreview);
    $('export-playlists-button').addEventListener('click', exportPlaylists);
    $('import-playlists-button').addEventListener('click', () => $('import-playlists-file').click());
    $('import-playlists-file').addEventListener('change', importPlaylists);
    $('pause-button').addEventListener('click', togglePause);
    $('stop-button').addEventListener('click', stopSession);
    $('new-session-button').addEventListener('click', () => {
        renderReplays();
        showSection('playlist-section');
    });
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

function enterApp() {
    showSection('playlist-section');
    renderTotals();
    renderReplays();
    renderKeyStatus();
    setUpPlayer();
    if (!github.viewer) loadGithub();
}

function boot() {
    setRandomBackground();
    wireEvents();
    if (youtubeSettings.getKey()) enterApp();
    else showKeySection();
}

boot();
