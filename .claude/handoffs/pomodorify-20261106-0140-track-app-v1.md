# Handoff: pomodorify-20261106-0140-track-app-v1

- Repo / branch / HEAD: `pomodorify` / `v2-totals` / wrapup commit on top of `c4af78e`. Pushed. Nothing uncommitted.
- Session: 2026-11-05 → 06. Built the v2 "session app" from `DESIGN_V2.md` as a separate app at `/track`.

## Where things stand
- **PR #8 merged and deployed** (2026-11-06): the track app at `https://pomodorifi.es/track/index.html`. In-tab Web Playback SDK, session clock, track N of M and time left, per-project local logging, SAVE export. The deploy passed, and both `/` and `/track/index.html` returned 200 afterwards.
- **PR #9 open** (`v2-totals`): Logged time table with JSON/CSV export and Clear, replay of saved `POMO_` playlists (stable random order), and the `[hidden]` CSS fix. Tested by hand in Safari locally. This wrapup commit (CLAUDE.md and this handoff) is on the same branch.
- `DESIGN_V2.md` v1 is marked complete and matches the code.
- The local dev server may still be running on `127.0.0.1:8080` (background task from this session).

## Next step
Scot reviews and merges PR #9. After that, confirm the deploy run passed, and check that `https://pomodorifi.es/track/index.html` shows the Logged time table and that PAUSE/STOP hide after a session ends.

## Open questions for Scot
1. **What next for v2?** The options are #7 (Spotify Feb 2026 migration, now covering both apps, and the most likely to break things), the GitHub issue logger (DESIGN_V2 "Options left open"), and #11 (local HTTPS for Safari).
2. **Root app future:** when, if ever, should `/track` replace `/`?

## Decisions this session
- The track app is separate at `/track` and the root app stays untouched. It only reads shared files and copies the code it needs (Scot).
- `/track/index.html`, not `/track/`, to avoid a CloudFront Function.
- `track_`-prefixed storage keys. `pomodorify_hours` stays unprefixed so a later replacement keeps the data.
- End detection is stateful (the SDK wraps to track 1 when a playlist ends), based on spike evidence.
- Discover Weekly dropped (Scot: never used, Spotify-specific). SAVE kept (Scot).
- Replay order is random once, then stable (Scot). New saved sessions are inserted at random positions (Claude's interpretation, not objected to).
- CSV rounds to 2 decimals and JSON keeps full precision. No undo for logging in v1. Clear states what it deletes.
- Two PRs; PR B branched after PR A merged (Scot).

## Issues filed / relevant
- #10 Root app inserts track and artist names as unescaped innerHTML
- #11 Local dev: Safari HTTPS-Only blocks the OAuth callback
- #12 Background image list duplicated in app.js and track/track.js
- #13 Playlist tracks capped at the first 100
- #7 Spotify Feb 2026 migration. A comment added this session says it applies to `track/` too.

## Gotchas
- **Port 8080 conflicts:** the Stewardship Atlas dev server was bound to `127.0.0.1:8080`, while ours only got IPv6, so requests returned a 404. Check with `lsof -nP -iTCP:8080 -sTCP:LISTEN`.
- **Safari HTTPS-Only blocks the http OAuth callback.** Paste the callback URL and accept the warning.
- `style.css` `display` rules override the `hidden` attribute (fixed for `track/` in PR #9).
- The auto-mode classifier denied `kill` on a server Claude had started. Ask Scot to run it.

## Verify state on pickup
```bash
git fetch && git log --oneline -3 origin/main
gh pr view 9 --json state,mergedAt
gh run list --limit 2
curl -s -o /dev/null -w "%{http_code}\n" https://pomodorifi.es/track/index.html
node tests/track.test.mjs | tail -1   # expect 61 passed
```
