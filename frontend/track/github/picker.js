// Pure helpers for the "Project" / issue pickers in the preview section.

export const NO_PROJECT = 'none';
export const NEW_ISSUE = '__new';

// The Project dropdown's value: 'none', 'project:<id>' or 'repo:<id>'.
export function parseProjectChoice(value) {
    const [kind, ...rest] = String(value || NO_PROJECT).split(':');
    const id = rest.join(':');
    if ((kind === 'project' || kind === 'repo') && id) return { kind, id };
    return { kind: 'none' };
}

export const projectValue = (kind, id) => `${kind}:${id}`;

// How an issue appears in the dropdown and in local totals.
export const issueLabel = (issue) => `${issue.repo}#${issue.number} ${issue.title}`;

// The repo most of a project's issues live in, or the first repo if the
// project is empty. Used to default the new-issue repo picker.
export function defaultRepoId(issues, repos) {
    const counts = new Map();
    for (const issue of issues) counts.set(issue.repoId, (counts.get(issue.repoId) || 0) + 1);
    let best = null;
    for (const [id, count] of counts) {
        if (best === null || count > counts.get(best)) best = id;
    }
    return best ?? repos[0]?.id ?? null;
}

export const DEFAULT_ISSUE_TYPE = 'Task';
