// Manual live check of the track app's GitHub read queries (not run in CI).
// Read-only: it lists repos, projects, issues and epics and resolves hours targets,
// and it writes nothing. Run from the repo root:
//   GH_TOKEN=$(gh auth token) node tests/github-live-reads.mjs
import { createGithubApi } from '../frontend/track/github/api.js';
import { resolveHoursTarget, describeTarget } from '../frontend/track/github/hours-target.js';
import { DEFAULT_HOURS_FIELDS } from '../frontend/track/github/settings.js';
const api = createGithubApi(() => process.env.GH_TOKEN);
const v = await api.getViewer(); console.log('viewer', v.login);
const repos = await api.listRepos(); console.log('repos', repos.length, repos.slice(0,3).map(r=>r.name));
const projects = await api.listProjects(); console.log('projects', projects.map(p=>p.name));
const internal = repos.find(r => r.name === 'Salmon-Creek-Systems/internal');
const ri = await api.listRepoIssues(internal.id); console.log('internal open issues', ri.length, ri[0]);
const ta = projects.find(p => p.name.includes('TA 2026'));
const pi = await api.listProjectIssues(ta.id); console.log('TA project issues', pi.length, pi[0]?.title);
const atlas = projects.find(p => p.name.endsWith('Stewardship Atlas'));
const ai = await api.listProjectIssues(atlas.id); console.log('Atlas project issues', ai.length);
for (const id of [ri[0].id, 'I_kwDOMOIwjc6xfoIG']) {
  const t = resolveHoursTarget(await api.getIssueHoursInfo(id), DEFAULT_HOURS_FIELDS); console.log('target', describeTarget(t));
}
const pom = repos.find(r => r.name === 'scotfree/pomodorify');
const pt = resolveHoursTarget(await api.getIssueHoursInfo((await api.listRepoIssues(pom.id))[0].id), DEFAULT_HOURS_FIELDS);
console.log('personal repo target', pt.kind);
const ci = await api.getRepoCreateInfo(internal.id, 'pomodorify created'); console.log('createInfo', ci.org, ci.issueTypes.map(t=>t.name), ci.labelId, ci.numberFields.map(f=>f.name));
console.log('personal createInfo', JSON.stringify(await api.getRepoCreateInfo(pom.id, 'pomodorify created')));
const epics = await api.listOrgEpics('Salmon-Creek-Systems'); console.log('epics', epics.length, epics[0]?.title);
