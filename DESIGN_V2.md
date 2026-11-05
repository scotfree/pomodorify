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

### 1. Spotify playback in the tab (Web Playback SDK)

- Load `https://sdk.scdn.co/spotify-player.js`. Create a `Spotify.Player` whose
  `getOAuthToken` callback calls `ensureValidToken()` and returns `this.accessToken`.
- On `ready`, keep the `device_id`. Start playback with a single
  `PUT /me/player/play?device_id=…` containing **all** track URIs in `uris`. This
  replaces the current clear-queue / play-first / queue-the-rest-with-100ms-delays logic.
- Add the `streaming` scope. Existing tokens need a re-login, so detect the missing scope
  and send the user to login.
- Call `player.activateElement()` inside the Start click handler. Browsers block audio
  that isn't started by a user gesture.
- Use `player_state_changed` to drive `onStateChange`. Treat the session as ended when the
  last track has finished: the state is paused, the position is 0, and the last track
  appears in `previous_tracks`. Treat a null state (device lost) as stopped.
- Premium is required, which is the same gate as today's PLAY button.

New file: `frontend/playback/spotify.js`.

### 2. Session screen

- Add a fifth section, `session-section`, managed by a new `showSessionSection()`.
- The preview screen gets an optional **Project** text input that uses a `<datalist>` of
  previously used project names, plus a **Start session** button. Start session replaces
  the current PLAY button. SAVE (export mode) stays.
- The session screen shows the current track, elapsed time, Pause/Resume, and Stop.
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

New file: `frontend/loggers/local.js`.

### 4. Totals view and export

- On the playlist screen, add a small table of project → hours (2 decimals), plus
  three buttons:
  - **Export JSON**, which downloads the totals object as `pomodorify-hours.json`.
  - **Export CSV**, which downloads `project,hours` rows for Excel.
  - **Clear**, which shows a `confirm()` and then calls `logger.clear()`.
- Downloads use a `Blob` and a temporary `<a download>`. No server is needed.

### 5. Replay a saved playlist

- `loadPlaylists()` already fetches everything and drops `POMO_` playlists. Keep those in
  a second list instead of discarding them.
- Add a "Replay a saved session" dropdown. Choosing one loads its tracks **in order**, with
  no shuffle and no duration fitting, then goes to preview → Start session. This keeps the
  "same playlist, you know where you are" benefit.

### 6. Tests

- Add the following to `tests/test.mjs`:
  - local logger adds to totals across calls;
  - new projects appear in `getTotals()`;
  - `clear()` empties everything;
  - CSV formatting (put it in `utils.js`, with a project name containing a comma).
- Playback isn't unit-tested. Test it manually in the browser.

### Out of v1

GitHub logging, server-side storage, a fetchable log URL, YouTube, multiple users,
app-owned playlists, and metadata filters.

## Options left open (later)

### GitHub issue logger
- Choose an issue from a dropdown instead of typing a project name. On session end,
  increment the org-level **Hours worked** number field on the issue's project item.
- This needs a GitHub token with project access. For a single user, use a pasted
  fine-grained token in `localStorage`. For multiple users, use OAuth via a Lambda,
  because GitHub's token exchange needs a client secret.
- It's a second implementation of the logger interface, and it serves as the test that
  the interface is real.

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

- Should a stopped-early session also have an "undo / don't log" option, or is
  always-log-actual-time fine?
- Should the session screen show position in the playlist (track 4 of 9, time remaining)?
  It's cheap, and it's the main benefit of a familiar playlist.
