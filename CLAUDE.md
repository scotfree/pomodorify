# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Pomodorify is a pure client-side static web app. No build step, no package manager, no server. Three files do everything: `frontend/index.html`, `frontend/app.js`, `frontend/style.css`.

Deployed at `https://pomodorifi.es`.

## Running Locally

Serve the `frontend/` directory with any static file server:

```bash
cd frontend && python3 -m http.server 8080
# or
npx serve frontend
```

For OAuth to work locally, `http://localhost:8080` (or whichever port) must be added as a redirect URI in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) for this app, **and** `this.redirectUri` in `app.js` must be temporarily changed to match.

## Architecture

Everything lives in a single `PomodorifyApp` class (`frontend/app.js`). The UI has four sections (`login-section`, `playlist-section`, `preview-section`, `result-section`) that are toggled via `display: none/block` — only one is visible at a time. The `show*Section()` methods handle all transitions.

**Auth**: Spotify Authorization Code flow with PKCE. Tokens stored in `localStorage`. `ensureValidToken()` is called at the top of every API method and auto-refreshes when within 5 minutes of expiry.

**Playlist sources** (all funnel into `selectTracksForDuration` → `displayPreview`):
- User's saved playlists (paginated, sorted A-Z, `POMO_`-prefixed playlists excluded)
- Discover Weekly (auto-detected by name + owner == "Spotify")
- Free-text search (Spotify search API)

**Playlist generation**: `selectTracksForDuration` shuffles tracks and fills up to the duration limit, always adding one track over the limit. Generated playlists are named `POMO_{source}_{timestamp}` and are created as private.

**Playback** (Premium-only): starts first track via `PUT /me/player/play` on the active device, then queues remaining tracks one by one with a 100ms delay between calls. `window.currentPreview` holds the in-progress track list between preview and save/play.

**Hardcoded values** in `app.js`:
- `this.clientId` (line 3) — Spotify app Client ID
- `this.redirectUri` (line 4) — must match Spotify dashboard and current environment

## Key Decisions

- `config/` is reference-only and not used at runtime (the app is client-only, no server reads it)
- `POMO_` prefix on generated playlists is intentional — it's how the dropdown filters them out on reload
- The play button is disabled for non-Premium users (checked via `/me` user product field)
- Background images are selected randomly on each page load from `frontend/assets/`
- `test.html` is a manual browser-based test page for PKCE logic, not an automated test suite
