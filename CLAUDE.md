# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Pomodorify is a pure client-side static web app. No build step, no package manager, no server. There are two apps on one origin:

- **Root app** (`/`): `frontend/index.html`, `frontend/app.js`, `frontend/style.css`. It builds a duration-fitted playlist and saves or plays it in Spotify.
- **Track app** (`/track/index.html`, `frontend/track/`): v2 of the design in `DESIGN_V2.md`. It plays the playlist in the tab via the Web Playback SDK, runs a session clock, logs time per project to `localStorage`, and offers JSON/CSV export and replay of saved `POMO_` playlists. It may eventually replace the root app.
- **Spotless app** (`/spotless/index.html`, `frontend/spotless/`): a prototype of the track app with YouTube instead of Spotify, so it works for anyone (no Spotify developer-mode allowlist). Search YouTube, fit the results to a duration, name the playlist and keep it in `localStorage` (`spotless_playlists`, exportable/importable as a JSON file), play it in the tab with the IFrame Player API. Needs a YouTube Data API v3 key: pasted into the page (`spotless_youtube_key`) or baked in as `BUILT_IN_KEY` in `spotless/settings.js` (restrict it to the site's referrers).

Deployed at `https://pomodorifi.es`.

## CRITICAL: keep the two apps separate

- **The track app never edits shared files.** It only reads `../utils.js`, `../style.css` and `../assets/`. New logic goes in `frontend/track/`, even if it duplicates the root app. The root app and its deployment are meant to stay unchanged while `/track` matures.
- **Track app storage keys are prefixed `track_`**, so its Spotify session never touches the root app's. You log in to each app separately. The exception is `pomodorify_hours`, which is unprefixed on purpose: the root app doesn't use it, and staying unprefixed means a later replacement keeps the data.

## Spotless and the track app

- Spotless never edits track app or shared files. It **imports the platform-neutral track modules read-only**: `track/session.js`, `track/export.js`, `track/loggers/*`, `track/github/*`. So changes to those must keep `tests/spotless.test.mjs` (and the Spotless page) working.
- Deliberately shared state: `pomodorify_hours` (same local totals as the track app) and the GitHub settings and pending queue (`track_github_*`), so you paste the token once and hours land in one place. Spotless's own keys are prefixed `spotless_`.
- No login and no redirect URI: it's an API key, not OAuth.

## Running Locally

```bash
cd frontend && python3 -m http.server 8080
```

Open `http://127.0.0.1:8080` (root) or `http://127.0.0.1:8080/track/index.html` (track) or `http://127.0.0.1:8080/spotless/index.html` (spotless). The redirect URI is auto-detected based on hostname. Use `127.0.0.1` not `localhost` — Spotify rejects `localhost` as insecure in the Developer Dashboard.

Registered redirect URIs: `http://127.0.0.1:8080`, `https://pomodorifi.es`, `http://127.0.0.1:8080/track/index.html`, `https://pomodorifi.es/track/index.html`. Port 8080 is fixed by these, so check nothing else is bound to it (`lsof -nP -iTCP:8080 -sTCP:LISTEN`). Other projects' dev servers have used it.

**Safari HTTPS-Only mode blocks the OAuth callback** (an `http://` redirect). To work around it, paste the failed callback URL into the address bar and accept the warning, or use Chrome. The fix is tracked in #11.

## Tests

```bash
node tests/test.mjs
```

```bash
node tests/track.test.mjs
```

```bash
node tests/spotless.test.mjs
```

CI runs all three. `tests/test.mjs` covers the root app's pure functions in `frontend/utils.js`. The `selectTracksForDuration` function accepts an injectable shuffle function as a third argument (defaults to `Math.random`).

`tests/track.test.mjs` covers the track app. Everything with logic takes its dependencies (storage, `now`, `fetch`, the SDK loader, `random`) as injectable arguments. That includes the playback adapter, which is tested against a fake `Spotify.Player`. The end-detection fixtures are real Safari spike logs. DOM wiring (`track/track.js`) and the real SDK are tested by hand in the browser.

## Deployment

Hosted as static files: private S3 bucket → CloudFront (ACM cert) → Route 53 alias for `pomodorifi.es`. All defined in the CDK stack at `infra/app.mjs` (plain JS, stack name `Pomodorify`, us-east-1).

Push to `main` — GitHub Actions runs tests, assumes the deploy role via OIDC, `aws s3 sync`s `frontend/` to the bucket, invalidates CloudFront, then curls the site as a smoke test. Repo variables (not secrets): `AWS_DEPLOY_ROLE_ARN`, `SITE_BUCKET`, `CLOUDFRONT_DISTRIBUTION_ID` — values come from the stack outputs.

Infra changes:
```bash
cd infra && npm install
npm run diff     # cdk diff --profile personal
npm run deploy   # cdk deploy --profile personal
```

**AWS profiles:** always use `--profile personal`. There is deliberately no default profile. The `atlas` profile belongs to the Stewardship Atlas project — never use or modify it from here.

## Architecture

### Track app (`frontend/track/`)

- `track.js`: the UI. Five sections (`login`, `playlist`, `preview`, `session`, `result`) switched by `showSection(id)`.
- `auth.js`: PKCE with `track_` keys. The granted scope is stored, and a token missing any required scope counts as logged out.
- `spotify-api.js`: playlists, tracks, search, save. `playlists.js`: splitting off `POMO_` playlists and the replay order.
- `session.js`: the session clock (only counts while playing; repeat calls are harmless) and `createSession().finish()`, which logs once whether it's called by Stop, playlist end or `pagehide`. Also the time-left and clock display helpers.
- `playback/spotify.js`: the Web Playback SDK adapter. `playback/spotify-state.js`: pure state interpretation and end detection.
- `loggers/local.js`: `pomodorify_hours` totals. `export.js`: CSV/JSON formatting.
- `github/`: `api.js` (GraphQL), `hours-target.js` (which field gets the hours), `settings.js` (token, field names), `picker.js`. `loggers/github.js`: read-add-write with a pending retry queue.

### Spotless app (`frontend/spotless/`)

- `spotless.js`: the UI, adapted from `track/track.js`. Sections `key`, `playlist`, `preview`, `session`. The YouTube player (`#player-wrap`) sits outside the sections, parked off-screen except during a session: its iframe must be laid out to load, mustn't be moved (that reloads it), and must be visible (≥200×200) while playing.
- `youtube-api.js`: `search.list` + `videos.list` for durations. Search passes stop once there are 15 tracks: 4–20 min Music (`videoDuration=medium`), then short Music, then 4–20 min of any category. Without the duration filter, popular searches are mostly hours-long mixes and streams. Drops live, unembeddable, <1 min and >20 min videos. 101 quota units per search when the first pass is enough, up to 303 (10k/day default).
- `playlists.js`: the `spotless_playlists` store (newest first), export/import. `settings.js`: the API key.
- `playback/youtube.js`: the adapter. It steps through the list itself with `loadVideoById` so a video that won't play (errors 100/101/150) is skipped instead of stopping the session.

### Root app

Everything lives in a single `PomodorifyApp` class (`frontend/app.js`). The UI has four sections (`login-section`, `playlist-section`, `preview-section`, `result-section`) that are toggled via `display: none/block` — only one is visible at a time. The `show*Section()` methods handle all transitions.

**Auth**: Spotify Authorization Code flow with PKCE. Tokens stored in `localStorage`. `ensureValidToken()` is called at the top of every API method and auto-refreshes when within 5 minutes of expiry.

**Playlist sources** (all funnel into `selectTracksForDuration` → `displayPreview`):
- User's saved playlists (paginated, sorted A-Z, `POMO_`-prefixed playlists excluded)
- Discover Weekly (auto-detected by name + owner == "Spotify")
- Free-text search (Spotify search API)

**Playlist generation**: `selectTracksForDuration` shuffles tracks and fills up to the duration limit, always adding one track over the limit. Generated playlists are named `POMO_{source}_{timestamp}` and are created as private.

**Playback** (Premium-only): starts first track via `PUT /me/player/play` on the active device, then queues remaining tracks one by one with a 100ms delay between calls. `window.currentPreview` holds the in-progress track list between preview and save/play.

**Pure logic functions** live in `frontend/utils.js` and are imported by `app.js` as ES modules. `index.html` uses `type="module"` on the script tag. `package.json` exists solely to tell Node to treat `.js` files as ES modules.

## Next Steps

- **Spotify February 2026 API migration (#7)** — now covers both apps. The track app copied the same deprecated endpoints and the `product`-based Premium check.
- **Background image management** — currently requires editing the hardcoded arrays in `app.js` *and* `track/track.js` (#12) and manually deploying assets, which is painful. Explore a better approach.
- **Track app follow-ons** — see "Options left open" in `DESIGN_V2.md` (cross-device log, YouTube).

## Key Decisions

- `POMO_` prefix on generated playlists is intentional — it's how the dropdown filters them out on reload
- The play button is disabled for non-Premium users (checked via `/me` user product field)
- Background images are selected randomly on each page load from `frontend/assets/` — `spaceship.jpg` was removed from the rotation due to rendering issues
- `background-attachment: fixed` was removed — conflicted with `backdrop-filter: blur` on `.container`, causing non-deterministic gray backgrounds in both Safari and Chrome
- `test.html` is a manual browser-based test page for PKCE logic, not an automated test suite
- Spotify rejects `localhost` as a redirect URI — use `127.0.0.1` instead
- `package.json` has no dependencies — only `"type": "module"` to enable ES modules in Node
- `selectTracksForDuration` shuffle is injectable to make it deterministically testable
- Hosted on S3 + CloudFront instead of EC2 — the app is pure static, so an always-on server was wasted money. CloudFront is required (not bare S3 website hosting) because Spotify requires an HTTPS redirect URI
- CDK stack account ID is pinned in `infra/app.mjs` so a deploy with the wrong profile fails instead of creating resources in another account
- CDK avoids Lambda-backed custom resources (native OIDC provider, no `deleteExisting` on records) to keep the stack to plain CloudFormation resources
- GitHub Actions authenticates to AWS via OIDC (role restricted to `main` of this repo) — no long-lived AWS keys in GitHub
- Future server-side features: add a Lambda behind the same CloudFront distribution on `/api/*` (same origin, no CORS)
- `config/` (old Flask-era config with a Spotify client secret) was removed; PKCE needs no secret
- The track app is a separate app at `/track` rather than a change to the root app. Scot wanted the current app and its deployment left alone until v2 proves itself
- The track app's URL is `/track/index.html`, not `/track/`. CloudFront's `defaultRootObject` only covers `/`, and a pretty URL would need a CloudFront Function, which is an infra change we chose not to make
- **End detection is stateful.** At the end of a playlist the Web Playback SDK wraps back to track 1 and pauses, which looks the same as "paused before starting". `ended` therefore means a paused state on an earlier track after the last track was reached. Don't simplify it to a rule that only looks at the current state (see `playback/spotify-state.js`)
- The SDK sends every change as a burst of 2–5 identical states. The adapter deduplicates them
- `playback.play()` must run inside the click handler with nothing awaited first, because browsers block audio that isn't started by a user gesture. Load tracks before the click
- Discover Weekly is dropped from the track app. It's Spotify-specific and unused (and unreadable after the Feb 2026 API changes)
- Replay list order: random the first time, then stable (`track_replay_order`). New saved sessions are inserted at random positions. That's Scot's choice
- `track.css` has `[hidden] { display: none !important; }` because `style.css` sets `display` on classes like `.button-group`, which otherwise override the `hidden` attribute
- GitHub hours go to the first match in an ordered field-name list (org issue field, then Projects v2 number field), else a comment. Default `Worked Hours`, `Time Actual[hours]`. `Worked Hours` is the Salmon-Creek-Systems org issue field from the internal repo's TA project system; Time Actual is an older project #4 field. Scot chose the fallback chain
- GitHub has no atomic increment. Don't drop the pending queue's "already written?" check on retry: it's what stops a lost response from double-adding hours
- Issues created from the track app get the `pomodorify created` label and are assigned to the viewer
- GitHub auth is a pasted classic PAT, because fine-grained tokens reportedly can't access user-owned Projects v2 (not verified)
- Logging always records actual time played. There's no "undo / don't log" in v1; Clear plus the JSON export cover mistakes
