// Copied from ../spotless/labels.js (the apps don't import each other's code).
// Labels on playlists: each session that plays adds its labels (the GitHub
// issue's labels, or the ones typed for a No Project session) to the
// playlist's { label: sessions } counts, so over time you can see which kinds
// of work each playlist gets used for.

// Labels Pomodorify adds itself; counting them would only measure the app.
export const IGNORED_LABELS = ['pomodorify created'];

const key = (name) => name.toLowerCase();

// "bug, UI ,, bug" -> ['bug', 'UI']: trimmed, blanks and repeats (any case) dropped.
export function parseLabels(text) {
    return normalizeLabels(String(text ?? '').split(','));
}

export function normalizeLabels(names) {
    const seen = new Set(IGNORED_LABELS);
    const out = [];
    for (const raw of names ?? []) {
        const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
        if (!name || seen.has(key(name))) continue;
        seen.add(key(name));
        out.push(name);
    }
    return out;
}

// Adds 1 per label. A label matches an existing one in any case and keeps
// the existing spelling. Returns a new object.
export function addLabelCounts(counts, names) {
    const out = { ...(counts ?? {}) };
    const existing = new Map(Object.keys(out).map(k => [key(k), k]));
    for (const name of normalizeLabels(names)) {
        const k = existing.get(key(name)) ?? name;
        out[k] = (out[k] ?? 0) + 1;
        existing.set(key(name), k);
    }
    return out;
}

// Most used first, then by name.
export function sortedLabels(counts) {
    return Object.entries(counts ?? {})
        .sort(([a, x], [b, y]) => y - x || a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// "bug ×3, UI ×1"
export function formatLabelCounts(counts) {
    return sortedLabels(counts).map(([name, n]) => `${name} ×${n}`).join(', ');
}

// The issue's label names, via the track app's GitHub API object (its graphql
// method; ../track/github/api.js itself is left alone).
export async function fetchIssueLabels(api, issueId) {
    const data = await api.graphql(
        'query($id: ID!) { node(id: $id) { ... on Issue { labels(first: 50) { nodes { name } } } } }',
        { id: issueId });
    return normalizeLabels((data.node?.labels?.nodes ?? []).map(l => l?.name));
}
