# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Pomodorify is a pure client-side static web app. No build step, no package manager, no server. Three files do everything: `frontend/index.html`, `frontend/app.js`, `frontend/style.css`.

Deployed at `https://pomodorifi.es`.

## Running Locally

```bash
cd frontend && python3 -m http.server 8080
```

Open `http://127.0.0.1:8080` — the redirect URI is auto-detected based on hostname. Use `127.0.0.1` not `localhost` — Spotify rejects `localhost` as insecure in the Developer Dashboard.

`http://127.0.0.1:8080` is already registered in the Spotify Developer Dashboard.

## Tests

```bash
node tests/test.mjs
```

Pure logic functions are in `frontend/utils.js` (ES module). Tests cover `formatDuration`, `selectTracksForDuration`, and `generateRandomString`. The `selectTracksForDuration` function accepts an injectable shuffle function as a third argument (defaults to `Math.random`).

## Deployment

Push to `main` — GitHub Actions runs tests then deploys automatically via SSH to the nginx server.

Manual deploy (if needed):
```bash
ssh ec2-user@54.176.238.172
cd ~/pomo && git pull
sudo cp -r ~/pomo/frontend/* /usr/share/nginx/html
```

SSL cert renewal (run when cert needs refreshing):
```bash
sudo systemctl stop nginx
sudo certbot renew
sudo systemctl start nginx
```

The deploy SSH key is stored as `DEPLOY_SSH_KEY` in GitHub Actions secrets.

## Architecture

Everything lives in a single `PomodorifyApp` class (`frontend/app.js`). The UI has four sections (`login-section`, `playlist-section`, `preview-section`, `result-section`) that are toggled via `display: none/block` — only one is visible at a time. The `show*Section()` methods handle all transitions.

**Auth**: Spotify Authorization Code flow with PKCE. Tokens stored in `localStorage`. `ensureValidToken()` is called at the top of every API method and auto-refreshes when within 5 minutes of expiry.

**Playlist sources** (all funnel into `selectTracksForDuration` → `displayPreview`):
- User's saved playlists (paginated, sorted A-Z, `POMO_`-prefixed playlists excluded)
- Discover Weekly (auto-detected by name + owner == "Spotify")
- Free-text search (Spotify search API)

**Playlist generation**: `selectTracksForDuration` shuffles tracks and fills up to the duration limit, always adding one track over the limit. Generated playlists are named `POMO_{source}_{timestamp}` and are created as private.

**Playback** (Premium-only): starts first track via `PUT /me/player/play` on the active device, then queues remaining tracks one by one with a 100ms delay between calls. `window.currentPreview` holds the in-progress track list between preview and save/play.

**Pure logic functions** live in `frontend/utils.js` and are imported by `app.js` as ES modules. `index.html` uses `type="module"` on the script tag. `package.json` exists solely to tell Node to treat `.js` files as ES modules.

## Key Decisions

- `config/` is reference-only and not used at runtime (the app is client-only, no server reads it)
- `POMO_` prefix on generated playlists is intentional — it's how the dropdown filters them out on reload
- The play button is disabled for non-Premium users (checked via `/me` user product field)
- Background images are selected randomly on each page load from `frontend/assets/`
- `test.html` is a manual browser-based test page for PKCE logic, not an automated test suite
- Spotify rejects `localhost` as a redirect URI — use `127.0.0.1` instead
- `package.json` has no dependencies — only `"type": "module"` to enable ES modules in Node
- `selectTracksForDuration` shuffle is injectable to make it deterministically testable
