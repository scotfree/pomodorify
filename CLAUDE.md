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

- **Background image management** — currently requires editing the hardcoded array in `app.js` and manually deploying assets, which is painful. Explore a better approach.

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
