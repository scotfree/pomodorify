# Handoff: pomodorify-20261108-1103-github-logger

- Repo / branch / HEAD: pomodorify. Work merged to `main` via PR #14 (`25fe222`). This wrapup commit went straight to `main`, as Scot chose.
- Session: 2026-11-06 to 2026-11-08. Track app logs session hours to GitHub issues.

## Where things stand
- **Done, merged, deployed (#14):**
  - The preview has a **Project** dropdown: No Project (local title), open Projects v2 (user's and orgs'), then repos.
  - Choosing a project or repo gives an **Issue** dropdown with **+ New issue**.
  - Hours go to the first match of the ordered field names (default `Worked Hours`, `Time Actual[hours]`). Each name is tried as an org issue field, then a Projects v2 number field. With no match, the hours are posted as a comment.
  - Writes are read-add-write, with a pending retry queue (`track_github_pending`) that won't double-add.
  - New issues get type, epic parent, Estimated Hours, assignee and the `pomodorify created` label.
- Scot tested it by hand on `127.0.0.1:8080` ("works pretty well"). The read queries were also run against live GitHub. There are 90 track tests.
- On `pomodorifi.es` the GitHub token has to be pasted again, since storage is per site. Get it from DevTools on the 127.0.0.1 page (`copy(localStorage.getItem('track_github_token'))`), or make a new classic PAT.
- **`main` moved on after #14 through other sessions** (PRs #15–#25): the Spotless YouTube app at `/spotless`, the track app reworked to the Spotless UI (#24, which also closed #20), and type-to-filter Project and Issue dropdowns (#25). The GitHub code from #14 is still in place underneath, but `track.js`, `index.html` and `track.css` look different from what this session wrote. Read them fresh. Tests: 104 passing at wrap-up.
- `tests/github-live-reads.mjs` is a manual, read-only live check of the GitHub queries (`GH_TOKEN=$(gh auth token) node tests/github-live-reads.mjs`). CI doesn't run it.

## Next step
Ask Scot what to pick up. GitHub candidates are #27 (the epic/rollup decision) and #26 (refresh issue lists; check how it fits the #25 type-to-filter dropdowns first). Spotless candidates are #18/#19, but their context comes from other sessions' handoffs, if any.

## Open questions for Scot
1. **Epics (#27):** hide epics from the picker, warn on them, or comment only? Logging straight to an epic fights the internal repo's Worked Hours rollup.
2. **Token (#28):** is it worth testing a fine-grained token to narrow the scopes?

## Decisions this session
- Field names are a setting holding an ordered list, with a comment as the final fallback (Scot's design). `Time Actual[hours]` is a project #4 field, not an org issue field.
- The first dropdown option is labeled "No Project". It behaves like the old title box with recent values.
- New issues: from a project, the repo defaults to where most of the project's issues live. Epics are any open Epic across the org. Creating is a separate button, because `playback.play()` can't wait on anything.
- The picker lists all open issue types, epics included ("all, for now"). See #27.
- Local totals always get the hours too, keyed `owner/repo#N Title`.
- Auth is a pasted classic PAT ("whatever is simplest").

## Issues filed / relevant
- #26 Track app: refresh the GitHub issue lists without reloading the page
- #27 Track app: logging hours directly to an epic conflicts with the internal repo's Worked Hours rollup
- #28 Track app: check whether a fine-grained GitHub token works, and narrow the requested scopes if it does
- Older: #7, #10–#13

## Gotchas
- GitHub has no atomic number increment (`IssueFieldUpdateOperation.ADD` just sets a value). Keep the retry's "already written?" check.
- GitHub introspection allows `__Type.fields` only twice per query. Introspect one type at a time.
- Org issue fields come back as `{}` nodes for types the fragments don't match (single-select, date). Filter on `id`.
- A wrapup commit made on a feature branch after its PR merges gets stranded. That happened to `eaf4abc`, which had to be cherry-picked.
- Port 8080: check `lsof -nP -iTCP:8080 -sTCP:LISTEN` before starting the server.

## Verify state on pickup
- `git fetch && git log --oneline -3 origin/main` (expect `4cdc2f6` or later)
- `node tests/track.test.mjs` (104 passing at handoff)
- `gh issue list --limit 15`
- `curl -s -o /dev/null -w '%{http_code}\n' https://pomodorifi.es/track/github/api.js` (expect 200)
