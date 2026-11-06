# Pomodorify v2 — Design

Status: draft, 2026-11-05

## Goal

Turn Pomodorify from "a tool that writes playlists into Spotify" into a **session app**:
pick a playlist, press start, and the web app plays it, keeps time, and (optionally) logs
that time against a project. The current "make a Spotify playlist and play it in Spotify"
flow stays as an option.

## Core idea: separate the app into four parts

```
 Playlist builder ──► playlist (platform-specific track list)
                              │
                              ▼
                     Session core  ──►  Logger (optional)
                     (timer, UI)        local totals | GitHub | …
                              │
                              ▼
                     Playback adapter
                     Spotify SDK | YouTube player | …
```

| Part | Responsibility | Platform-specific? |
|---|---|---|
| **Session core** | Start / pause / stop, elapsed time, project picker, UI | No |
| **Playback adapter** | Play a list of tracks in the tab, report play/pause/end | Yes, but small |
| **Playlist builder** | Turn a source (playlist, search, filters) into a duration-fitted track list; optionally export to the platform | Yes, and this is the hard part |
| **Logger** | Record hours against a project; report totals | No (each logger is its own module) |

A playlist belongs to one platform. We don't translate Spotify playlists to YouTube or
vice versa.

### Two modes

1. **Tracked session.** Playback happens in the web app tab. That's the only way the app
   knows when music starts, pauses and ends, so it's required for logging.
2. **Export.** This is today's SAVE: write the playlist to the user's Spotify account and
   play it in Spotify. There's no time tracking in this mode.

## Interfaces

Plain JS objects. There are no classes or frameworks beyond what exists.

```js
// Playback adapter
{
  async init(),                 // load SDK, connect, resolve when ready
  async play(tracks),           // tracks: [{ uri, name, artist, duration_ms }]
  async pause(),
  async resume(),
  async stop(),
  onStateChange(cb),            // cb({ playing: bool, trackIndex, ended: bool })
}

// Logger
{
  name,                         // e.g. 'local'
  addHours(project, hours),     // add to running total
  getTotals(),                  // { [project]: hours }
  clear(),                      // delete all log state
}
```

The session core only talks to these two interfaces.

## Shortest path (v1, for Scot only)

The scope is Spotify only, a single user, no backend, and nothing new in AWS.

**Status (2026-11-06):** v1 is complete. Steps 1–3 shipped in PR A (#8), steps 4–5 in PR B.

### Where it lives: a separate app at `/track`

v1 is a standalone page that leaves the current app and its deployment unchanged. If it
works out, it may replace the root app later.

- Everything is under `frontend/track/`. The deploy already syncs `frontend/` recursively,
  so no workflow or CDK change is needed beyond running `tests/track.test.mjs` in CI.
- The URL is `/track/index.html`, not `/track/`. CloudFront's `defaultRootObject` only
  covers `/`, and serving `/track/` would need a CloudFront Function.
- Redirect URIs `http://127.0.0.1:8080/track/index.html` and
  `https://pomodorifi.es/track/index.html` are registered in the Spotify Dashboard.
- Both apps share an origin, so the track app prefixes its auth keys with `track_` and
  never touches the root app's session. You log in to each app separately.
- The track app copies what it needs from `app.js` and only *reads* shared files
  (`utils.js`, `style.css`, `assets/`). It never edits them.
- Discover Weekly is dropped. It's Spotify-specific and unused.

Layout: `track.js` (UI), `auth.js`, `spotify-api.js`, `session.js` (clock, session,
display helpers), `playback/spotify.js` (adapter), `playback/spotify-state.js` (pure state
interpretation and end detection), `loggers/local.js`.

### 1. Spotify playback in the tab (Web Playback SDK)

- Load `https://sdk.scdn.co/spotify-player.js`. Create a `Spotify.Player` whose
  `getOAuthToken` callback calls `ensureValidToken()` and returns `this.accessToken`.
- On `ready`, keep the `device_id`. Start playback with a single
  `PUT /me/player/play?device_id=…` containing **all** track URIs in `uris`. This
  replaces the current clear-queue / play-first / queue-the-rest-with-100ms-delays logic.
- Add the `streaming` scope. Store the scope string from the token response, and treat a
  token missing any required scope as logged out, which sends the user to login.
- Call `player.activateElement()` inside the Start click handler. Browsers block audio
  that isn't started by a user gesture.
- Use `player_state_changed` to drive `onStateChange`. Treat a null state (device lost) as
  stopped.
- **End detection (revised after the spike).** At the end of the playlist the SDK wraps
  back to track 1 and pauses. One transitional state briefly shows the last track in
  `previous_tracks`, then the queue resets and looks the same as "paused before starting".
  So the rule is stateful: the session has ended if the last track was reached and a paused
  state then shows an earlier track. Pausing on the last track isn't an end. The adapter
  pauses the player on end so it stays silent.
- The SDK sends each change as a burst of 2–5 identical states. The adapter only emits real
  changes in playing, paused or track index.
- Match the current track via `linked_from.uri` when it's present (track relinking).
- Premium is required, which is the same gate as today's PLAY button.

Files: `frontend/track/playback/spotify.js`, `frontend/track/playback/spotify-state.js`.

### 2. Session screen

- The track page has `login`, `playlist`, `preview`, `session` and `result` sections,
  switched by `showSection(id)`.
- The preview screen gets an optional **Project** text input that uses a `<datalist>` of
  previously used project names, plus a **Start session** button. Start session replaces
  the current PLAY button. SAVE (export mode) stays.
- The session screen shows the current track, elapsed time, Pause/Resume, Stop, and
  "Track N of M · X min left". Time left is the rest of the current track (session-clock
  time since the track started) plus the later tracks' durations.
- Start session runs `playback.play()` with nothing awaited first, so the click still counts
  as the user gesture.
- Elapsed time is counted by the app clock and only accumulates while the adapter reports
  `playing`. It's actual time, not the playlist's planned length.
- When the session ends (playlist finishes or Stop is pressed), the elapsed hours are
  added to the logger if a project was entered. A blank project means nothing is logged.
  Also flush on `pagehide`, so closing the tab mid-session still counts.

### 3. Local totals logger

- Storage key: `pomodorify_hours` → `{ "Project name": 3.42, … }` (hours, float).
- The project dropdown is built from `Object.keys(getTotals())`. A project exists once it
  has logged time.
- `clear()` removes the key, which deletes all log state (projects and hours).
- The storage object is injected (default `localStorage`) so Node tests can pass in a
  plain-object fake. This follows the same pattern as the injectable shuffle.

File: `frontend/track/loggers/local.js`. The key isn't `track_`-prefixed, because the root app
doesn't use it and keeping it unprefixed survives a later replacement.

### 4. Totals view and export

- On the playlist screen, add a small table of project → hours (2 decimals), plus
  three buttons:
  - **Export JSON**, which downloads the totals object as `pomodorify-hours.json`.
  - **Export CSV**, which downloads `project,hours` rows for Excel. Hours are rounded to 2
    decimals, while JSON keeps full precision so it works as a backup.
  - **Clear**, which shows a `confirm()` stating what will be deleted ("Delete 12.40 h
    across 3 projects?") and then calls `logger.clear()`.
- Downloads use a `Blob` and a temporary `<a download>`. No server is needed.

### 5. Replay a saved playlist

- `loadPlaylists()` already fetches everything and drops `POMO_` playlists. Keep those in
  a second list instead of discarding them.
- Add a "Replay a saved session" dropdown. Choosing one loads its tracks **in order**, with
  no shuffle and no duration fitting, then goes to preview → Start session. This keeps the
  "same playlist, you know where you are" benefit.
- The replay preview hides REBUILD, which would only reshuffle a fixed playlist, and SAVE,
  which would copy a saved one.
- **Order:** random the first time, then stable. The order is stored as
  `track_replay_order`. Deleted playlists drop out, and new ones are inserted at random
  positions. Starting from an empty stored order, that's the same as a shuffle.

### 6. Tests

- Track-app tests live in `tests/track.test.mjs`, so `tests/test.mjs` stays the root
  app's. CI runs both.
- Covered: the local logger, the session clock and `finish()`-once, time left and clock
  formatting, auth (scope check, `track_` key isolation, refresh), end detection (fixtures
  replayed from the Safari spike logs), and the adapter wired to a fake `Spotify.Player`.
- CSV and JSON formatting (`track/export.js`: quoting, rounding, sort order) and
  playlist partitioning and replay ordering (`track/playlists.js`).
- DOM wiring and the real SDK are tested by hand in the browser.

### Out of v1

Server-side storage, a fetchable log URL, YouTube, multiple users,
app-owned playlists, and metadata filters.

## Options left open (later)

### GitHub issue logger (built, branch `v2-github`)
- The preview's **Project** dropdown lists "No Project" (local totals, typed title as
  before), then open Projects v2 (yours and your orgs'), then repos. Choosing a project
  or repo loads its open issues into an **Issue** dropdown, which also offers
  **+ New issue**.
- **Where the hours go:** an ordered list of field names (setting, default
  `Worked Hours`, `Time Actual[hours]`). For each name: an org-level issue field, then a
  Projects v2 number field on any project the issue is in. The first match wins, and an
  unset value counts as 0. With no match, an "hours worked" comment is posted. See
  `github/hours-target.js`.
- **No atomic increment** in GitHub's API, so it's read, add, write. Stop and playlist
  end re-read first. On `pagehide` the target resolved at session start is used, and the
  write goes out as a single `keepalive` request.
- **Pending queue** (`track_github_pending`): each write is recorded before it's sent and
  removed on success, and it's retried on the next load. A retry skips writes that
  landed but didn't report back: a field already holding the value we meant to write, or
  a comment with this session's `<!-- pomodorify-session:ID -->` marker.
- **New issue:** title, type (default Task), epic (any open Epic in the org, linked as
  parent), Estimated Hours (if the org has the field). It's assigned to you and labeled
  `pomodorify created` (the label is created if missing). From a project, you also pick a
  repo, defaulting to where most of the project's issues live. Creating is a separate
  button, not part of Start, because `playback.play()` can't wait on anything.
- Local totals always get the hours too, keyed `owner/repo#N Title`.
- **Auth:** a pasted classic PAT (`repo`, `project`, `read:org`) in `track_github_token`.
  Fine-grained tokens (as of late 2026, unverified) can't reach user-owned Projects v2. Multiple users would need
  OAuth via a Lambda.

### Fetchable log / cross-device history
- Add a Lambda on `/api/*` behind the existing CloudFront distribution (same origin, no
  CORS), storing data in S3 or DynamoDB. This is the same step multi-user needs.

### Multiple users
- Users are blocked on Spotify by development-mode allowlisting. The realistic path to
  "anyone can use it" is a second platform.
- Each user picks a platform when they sign in (Spotify or YouTube). That choice decides
  which playback adapter and playlist builder load.
- Once playlists aren't stored in the platform's account, they live in the app: a name
  plus ordered track references, stored in `localStorage` at first and server-side later.

### YouTube platform

**Status (2026-11-06):** prototype built as a separate app, `/spotless/index.html`
(`frontend/spotless/`). Search only, playlists in `localStorage`, an API key instead of
sign-in. See CLAUDE.md.
- **Playback:** YouTube IFrame Player API. It's easy to wrap in the adapter interface and
  fires an ended event. The constraints are:
  - playback is video, not audio-only;
  - the player must be visible and at least 200×200 px;
  - it can't autoplay before it's visible;
  - some videos block embedding;
  - ads play.
- **Builder:** YouTube Data API search and playlist reads give candidate tracks, and
  video durations feed the existing `selectTracksForDuration`. Durations are less exact
  than Spotify's (intros, music-video extras).
- **What's lost:** Spotify-style audio features such as instrumental, energy and tempo.
  The best substitute is keyword filtering on titles.
- **Quota:** 10k units/day per project by default. Playlist writes are expensive, so
  store playlists in the app rather than in YouTube.

### Metadata-driven building (Spotify)
- Bring back filters like instrumental or danceability in the Spotify builder. Check the
  current availability of Spotify's audio-features endpoint before planning around it.

## Open questions

- ~~Should a stopped-early session have an "undo / don't log" option?~~ No, not for v1.
  It always logs actual time, and Clear plus the JSON export are enough to fix mistakes.
- ~~Should the session screen show position in the playlist?~~ Yes, built as
  "Track N of M · X min left".
