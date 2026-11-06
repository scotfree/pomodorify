// GitHub issue logger: adds a session's hours to an issue's hours field, or
// posts an "hours worked" comment when the issue has none (hours-target.js).
//
// GitHub has no atomic increment, so a write is read, add, write. Every write is
// recorded in a pending queue before it is sent and removed once it succeeds,
// so a failed write, or one cut off by closing the tab, is retried on the next
// load. A retry checks whether the earlier write landed after all: for a field,
// whether it already holds the value we meant to write; for a comment, whether
// the comment with this session's marker exists. That keeps a write that
// succeeded but never reported back from being added twice.

import { resolveHoursTarget, roundHours } from '../github/hours-target.js';

const PENDING_KEY = 'track_github_pending';

const marker = (id) => `<!-- pomodorify-session:${id} -->`;

export function commentBody(hours, date, id) {
    return `⏱ ${hours.toFixed(2)} hours worked (Pomodorify, ${date})\n\n${marker(id)}`;
}

// api: createGithubApi(...). getFieldNames: () => ordered names.
export function createGithubLogger({
    api,
    getFieldNames,
    storage = globalThis.localStorage,
    now = () => Date.now(),
    newId = () => `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
}) {
    let prepared = null;  // { issueId, target } for the current session

    function readPending() {
        try {
            const list = JSON.parse(storage.getItem(PENDING_KEY));
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    function savePending(list) {
        if (list.length > 0) storage.setItem(PENDING_KEY, JSON.stringify(list));
        else storage.removeItem(PENDING_KEY);
    }

    function upsertPending(entry) {
        savePending([...readPending().filter(e => e.id !== entry.id), entry]);
    }

    function removePending(id) {
        savePending(readPending().filter(e => e.id !== id));
    }

    async function resolve(issueId) {
        return resolveHoursTarget(await api.getIssueHoursInfo(issueId), getFieldNames());
    }

    // Sends one write. The pending entry is updated with what we're about to
    // write first, so a retry can tell whether it landed.
    async function write(entry, target, { keepalive = false } = {}) {
        if (target.kind === 'comment') {
            upsertPending({ ...entry, kind: 'comment', expected: null });
            const date = new Date(entry.at).toISOString().slice(0, 10);
            await api.addComment(target.issueId, commentBody(entry.hours, date, entry.id), { keepalive });
            return { kind: 'comment' };
        }
        const value = roundHours(target.current + entry.hours);
        upsertPending({ ...entry, kind: target.kind, fieldId: target.fieldId, expected: value });
        if (target.kind === 'issueField') {
            await api.setIssueFieldNumber(target.issueId, target.fieldId, value, { keepalive });
        } else {
            await api.setProjectFieldNumber(target.projectId, target.itemId, target.fieldId, value, { keepalive });
        }
        return { kind: target.kind, fieldName: target.fieldName, value };
    }

    // Whether an earlier attempt at `entry` already reached GitHub.
    async function alreadyWritten(entry, target) {
        if (entry.kind === 'comment') return api.hasComment(entry.issueId, marker(entry.id));
        return entry.expected != null
            && target.kind === entry.kind
            && target.fieldId === entry.fieldId
            && roundHours(target.current) === entry.expected;
    }

    return {
        name: 'github',

        // Resolves the target ahead of time, so a log on pagehide is a single write.
        async prepare(issueId) {
            const target = await resolve(issueId);
            prepared = { issueId, target };
            return target;
        },

        // fresh: re-read the field just before writing (Stop, playlist end).
        // Without it (pagehide) the prepared target is used and the request is
        // sent with keepalive. Returns what was written; throws if it failed
        // (the entry stays queued for retryPending).
        async log(issueId, hours, { fresh = true } = {}) {
            const entry = { id: newId(), issueId, hours, at: now() };
            upsertPending(entry);
            let target;
            if (!fresh && prepared?.issueId === issueId) {
                target = prepared.target;
            } else if (!fresh) {
                return { kind: 'queued' };  // nothing prepared yet; next load sends it
            } else {
                target = await resolve(issueId);
            }
            const result = await write(entry, target, { keepalive: !fresh });
            removePending(entry.id);
            prepared = null;
            return result;
        },

        pendingCount: () => readPending().length,

        // Retries queued writes, oldest first. Returns how many were sent or
        // found to be already done; failures stay queued.
        async retryPending() {
            let done = 0;
            for (const entry of readPending()) {
                try {
                    const target = await resolve(entry.issueId);
                    if (!(await alreadyWritten(entry, target))) {
                        const fresh = { id: entry.id, issueId: entry.issueId, hours: entry.hours, at: entry.at };
                        await write(fresh, target);
                    }
                    removePending(entry.id);
                    done++;
                } catch (error) {
                    console.error('GitHub retry failed:', error);
                }
            }
            return done;
        },
    };
}
