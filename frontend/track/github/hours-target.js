// Decides where a session's hours go on a GitHub issue. Pure: takes the issue
// node returned by api.getIssueHoursInfo() (see ISSUE_HOURS_QUERY in api.js).
//
// For each configured field name, in order:
//   1. an org-level issue field with that name (the value lives on the issue);
//   2. a Projects v2 number field with that name on any project the issue is in.
// The first match wins, and an unset value counts as 0. With no match, the
// hours are posted as a comment instead.

const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

function issueFieldTarget(issue, name) {
    const defs = issue.repository?.owner?.issueFields?.nodes ?? [];
    const def = defs.find(f => f?.id && same(f.name, name));
    if (!def) return null;
    const values = issue.issueFieldValues?.nodes ?? [];
    const value = values.find(v => v?.field?.id === def.id);
    return {
        kind: 'issueField',
        issueId: issue.id,
        fieldId: def.id,
        fieldName: def.name,
        current: value?.value ?? 0,
    };
}

function projectFieldTarget(issue, name) {
    for (const item of issue.projectItems?.nodes ?? []) {
        const defs = item?.project?.fields?.nodes ?? [];
        const def = defs.find(f => f?.id && f.dataType === 'NUMBER' && same(f.name, name));
        if (!def) continue;
        const values = item.fieldValues?.nodes ?? [];
        const value = values.find(v => v?.field?.id === def.id);
        return {
            kind: 'projectField',
            issueId: issue.id,
            projectId: item.project.id,
            projectTitle: item.project.title,
            itemId: item.id,
            fieldId: def.id,
            fieldName: def.name,
            current: value?.number ?? 0,
        };
    }
    return null;
}

export function resolveHoursTarget(issue, fieldNames) {
    for (const name of fieldNames) {
        const target = issueFieldTarget(issue, name) ?? projectFieldTarget(issue, name);
        if (target) return target;
    }
    return { kind: 'comment', issueId: issue.id };
}

// Hours are written to 2 decimal places so field values stay readable.
export const roundHours = (h) => Math.round(h * 100) / 100;

// One line for the UI: what will happen when the session is logged.
export function describeTarget(target) {
    if (target.kind === 'comment') return 'No hours field found: logs a comment.';
    const where = target.kind === 'projectField' ? ` (project "${target.projectTitle}")` : '';
    return `Adds to ${target.fieldName}${where}, now ${roundHours(target.current)} h.`;
}
