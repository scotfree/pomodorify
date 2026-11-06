// GitHub GraphQL calls for the track app: list repos, projects and issues,
// read an issue's hours fields, write hours, and create issues.

const ENDPOINT = 'https://api.github.com/graphql';
const MAX_ITEMS = 300;  // per list; paging stops here

// Fields resolveHoursTarget() needs (see hours-target.js).
const ISSUE_HOURS_FIELDS = `
    id number title
    repository { id nameWithOwner owner { __typename login
        ... on Organization { issueFields(first: 50) { nodes { ... on IssueFieldNumber { id name } } } } } }
    issueFieldValues(first: 50) { nodes { ... on IssueFieldNumberValue { value field { ... on IssueFieldNumber { id name } } } } }
    projectItems(first: 20) { nodes { id
        project { id title fields(first: 50) { nodes { ... on ProjectV2Field { id name dataType } } } }
        fieldValues(first: 50) { nodes { ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { id name } } } } } } }`;

const ISSUE_SUMMARY = 'id number title updatedAt repository { id nameWithOwner }';

function toIssue(node) {
    return {
        id: node.id,
        number: node.number,
        title: node.title,
        updatedAt: node.updatedAt,
        repoId: node.repository.id,
        repo: node.repository.nameWithOwner,
    };
}

const byUpdatedDesc = (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '');

// getToken: () => token string. fetchFn is injectable for tests.
export function createGithubApi(getToken, fetchFn = (...args) => fetch(...args)) {
    // keepalive lets a write finish while the page is closing (pagehide).
    async function graphql(query, variables = {}, { keepalive = false } = {}) {
        const response = await fetchFn(ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${getToken()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query, variables }),
            keepalive,
        });
        if (!response.ok) throw new Error(`GitHub request failed: ${response.status}`);
        const json = await response.json();
        if (json.errors?.length) throw new Error(`GitHub: ${json.errors.map(e => e.message).join('; ')}`);
        return json.data;
    }

    // Follows `after` cursors. getConnection(data) returns { nodes, pageInfo }.
    async function paged(query, variables, getConnection) {
        const all = [];
        let after = null;
        while (all.length < MAX_ITEMS) {
            const connection = getConnection(await graphql(query, { ...variables, after }));
            all.push(...connection.nodes.filter(Boolean));
            if (!connection.pageInfo.hasNextPage) break;
            after = connection.pageInfo.endCursor;
        }
        return all.slice(0, MAX_ITEMS);
    }

    return {
        graphql,

        async getViewer() {
            return (await graphql('query { viewer { id login } }')).viewer;
        },

        // Non-archived repos with issues, yours and your orgs', most recently updated first.
        async listRepos() {
            const nodes = await paged(`query($after: String) { viewer {
                repositories(first: 100, after: $after, isArchived: false, hasIssuesEnabled: true,
                    affiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR],
                    ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR],
                    orderBy: { field: UPDATED_AT, direction: DESC }) {
                    nodes { id nameWithOwner } pageInfo { hasNextPage endCursor } } } }`,
                {}, d => d.viewer.repositories);
            return nodes.map(r => ({ id: r.id, name: r.nameWithOwner }));
        },

        // Open Projects v2: yours, then each org's. One page each (50) is plenty.
        async listProjects() {
            const data = await graphql(`query { viewer {
                login
                projectsV2(first: 50, query: "is:open") { nodes { id title closed } }
                organizations(first: 50) { nodes { login
                    projectsV2(first: 50, query: "is:open") { nodes { id title closed } } } } } }`);
            const v = data.viewer;
            const owners = [{ login: v.login, projectsV2: v.projectsV2 }, ...v.organizations.nodes];
            return owners.flatMap(o => (o.projectsV2?.nodes ?? [])
                .filter(p => p && !p.closed)
                .map(p => ({ id: p.id, name: `${o.login}: ${p.title}` })));
        },

        async listRepoIssues(repoId) {
            const nodes = await paged(`query($id: ID!, $after: String) { node(id: $id) { ... on Repository {
                issues(first: 100, after: $after, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
                    nodes { ${ISSUE_SUMMARY} } pageInfo { hasNextPage endCursor } } } } }`,
                { id: repoId }, d => d.node.issues);
            return nodes.map(toIssue);
        },

        async listProjectIssues(projectId) {
            const items = await paged(`query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 {
                items(first: 100, after: $after, query: "is:open is:issue") {
                    nodes { content { ... on Issue { ${ISSUE_SUMMARY} state } } }
                    pageInfo { hasNextPage endCursor } } } } }`,
                { id: projectId }, d => d.node.items);
            return items
                .map(item => item.content)
                .filter(c => c?.id && c.state === 'OPEN')
                .map(toIssue)
                .sort(byUpdatedDesc);
        },

        async getIssueHoursInfo(issueId) {
            const data = await graphql(`query($id: ID!) { node(id: $id) { ... on Issue { ${ISSUE_HOURS_FIELDS} } } }`,
                { id: issueId });
            return data.node;
        },

        async setIssueFieldNumber(issueId, fieldId, value, opts) {
            await graphql(`mutation($issue: ID!, $field: ID!, $value: Float!) {
                setIssueFieldValue(input: { issueId: $issue, issueFields: [{ fieldId: $field, numberValue: $value }] }) {
                    clientMutationId } }`,
                { issue: issueId, field: fieldId, value }, opts);
        },

        async setProjectFieldNumber(projectId, itemId, fieldId, value, opts) {
            await graphql(`mutation($project: ID!, $item: ID!, $field: ID!, $value: Float!) {
                updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field,
                    value: { number: $value } }) { clientMutationId } }`,
                { project: projectId, item: itemId, field: fieldId, value }, opts);
        },

        async addComment(issueId, body, opts) {
            await graphql(`mutation($issue: ID!, $body: String!) {
                addComment(input: { subjectId: $issue, body: $body }) { clientMutationId } }`,
                { issue: issueId, body }, opts);
        },

        // Whether any of the issue's last 100 comments contains `text`.
        async hasComment(issueId, text) {
            const data = await graphql(`query($id: ID!) { node(id: $id) { ... on Issue {
                comments(last: 100) { nodes { body } } } } }`, { id: issueId });
            return data.node.comments.nodes.some(c => c.body.includes(text));
        },

        // What the new-issue form needs for one repo. Personal repos have no
        // issue types or org fields, so those come back empty.
        async getRepoCreateInfo(repoId, labelName) {
            const data = await graphql(`query($id: ID!, $label: String!) { node(id: $id) { ... on Repository {
                id nameWithOwner
                issueTypes(first: 20) { nodes { id name } }
                label(name: $label) { id }
                owner { __typename login ... on Organization {
                    issueFields(first: 50) { nodes { ... on IssueFieldNumber { id name } } } } } } } }`,
                { id: repoId, label: labelName });
            const repo = data.node;
            return {
                repoId: repo.id,
                repo: repo.nameWithOwner,
                org: repo.owner.__typename === 'Organization' ? repo.owner.login : null,
                issueTypes: repo.issueTypes?.nodes?.filter(Boolean) ?? [],
                labelId: repo.label?.id ?? null,
                numberFields: (repo.owner.issueFields?.nodes ?? []).filter(f => f?.id),
            };
        },

        async listOrgEpics(org) {
            const nodes = await paged(`query($q: String!, $after: String) {
                search(type: ISSUE, query: $q, first: 100, after: $after) {
                    nodes { ... on Issue { ${ISSUE_SUMMARY} } } pageInfo { hasNextPage endCursor } } }`,
                { q: `org:${org} type:Epic is:open is:issue` }, d => d.search);
            return nodes.filter(n => n.id).map(toIssue).sort(byUpdatedDesc);
        },

        async createLabel(repoId, name, color, description) {
            const data = await graphql(`mutation($repo: ID!, $name: String!, $color: String!, $description: String) {
                createLabel(input: { repositoryId: $repo, name: $name, color: $color, description: $description }) {
                    label { id } } }`,
                { repo: repoId, name, color, description });
            return data.createLabel.label.id;
        },

        // input: { repoId, title, issueTypeId?, parentIssueId?, projectId?, labelIds, assigneeIds, issueFields? }
        async createIssue(input) {
            const data = await graphql(`mutation($repo: ID!, $title: String!, $type: ID, $parent: ID,
                    $projects: [ID!], $labels: [ID!], $assignees: [ID!], $fields: [IssueFieldCreateOrUpdateInput!]) {
                createIssue(input: { repositoryId: $repo, title: $title, issueTypeId: $type, parentIssueId: $parent,
                    projectV2Ids: $projects, labelIds: $labels, assigneeIds: $assignees, issueFields: $fields }) {
                    issue { ${ISSUE_SUMMARY} } } }`, {
                repo: input.repoId,
                title: input.title,
                type: input.issueTypeId || null,
                parent: input.parentIssueId || null,
                projects: input.projectId ? [input.projectId] : null,
                labels: input.labelIds?.length ? input.labelIds : null,
                assignees: input.assigneeIds?.length ? input.assigneeIds : null,
                fields: input.issueFields?.length ? input.issueFields : null,
            });
            return toIssue(data.createIssue.issue);
        },
    };
}
