// Re-captures the help page screenshots (frontend/help/img/) from the live
// Spotless and track pages, with YouTube, Spotify and GitHub stubbed.
//   cd frontend && python3 -m http.server 8080   (in another terminal)
//   node tools/help-screenshots.cjs frontend/help/img

const { chromium } = require('playwright');
const OUT = process.argv[2];
const shot = async (loc, name) => { await loc.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 82 }); console.log('wrote', name); };

async function stubCommon(p) {
  // One background for every shot (setRandomBackground uses Math.random first).
  await p.addInitScript(() => { const r = Math.random; let first = true; Math.random = () => (first ? (first = false, 0.15) : r()); });
  await p.route('https://api.github.com/graphql', r => {
    const { query, variables } = JSON.parse(r.request().postData());
    const repo = 'scotfree/pomodorify';
    let data;
    if (query.includes('viewer { id login }')) data = { viewer: { id: 'U', login: 'scot' } };
    else if (query.includes('projectsV2')) data = { viewer: { login: 'scot', projectsV2: { nodes: [{ id: 'P1', title: 'Writing', closed: false }] }, organizations: { nodes: [] } } };
    else if (query.includes('repositories(')) data = { viewer: { repositories: { nodes: ['pomodorify', 'garden-planner', 'blog', 'dotfiles'].map((n, i) => ({ id: 'R' + i, nameWithOwner: 'scotfree/' + n })), pageInfo: { hasNextPage: false } } } };
    else if (query.includes('issues(first')) data = { node: { issues: { nodes: [
      ['Add a help page', 26], ['Show the task while a session runs', 20], ['Store the input list with built playlists', 19], ['Type-to-filter dropdowns', 18], ['Spotify API migration', 7]
    ].map(([t, n], i) => ({ id: 'I' + i, number: n, title: t, updatedAt: '2026-11-0' + (8 - i), repository: { id: 'R0', nameWithOwner: repo } })), pageInfo: { hasNextPage: false } } } };
    else if (query.includes('labels(first: 50)')) data = { node: { labels: { nodes: [{ name: 'docs' }] } } };
    else if (query.includes('issueFieldValues')) data = { node: { id: variables.id, number: 26, title: 't', repository: { id: 'R0', nameWithOwner: repo, owner: { __typename: 'User', login: 'scot' } }, issueFieldValues: { nodes: [] }, projectItems: { nodes: [] } } };
    else data = { node: { id: 'R0', nameWithOwner: repo, issueTypes: { nodes: [] }, label: null, owner: { __typename: 'User', login: 'scot' } } };
    r.fulfill({ json: { data } });
  });
}

(async () => {
  const b = await chromium.launch();

  // ---------- Spotless ----------
  {
    const ctx = await b.newContext({ viewport: { width: 760, height: 1200 }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on('pageerror', e => console.log('pageerror', e.message));
    await stubCommon(p);
    await p.route('https://www.youtube.com/iframe_api', r => r.fulfill({ contentType: 'text/javascript', body: `
      window.YT = { Player: class { constructor(id, o) { this.o = o; const el = document.getElementById(id);
        const f = document.createElement('iframe'); f.width = o.width; f.height = o.height;
        f.srcdoc = '<body style="margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#2a1838,#0e0e16);color:#e6e6fa;font:600 14px system-ui">&#9654;&nbsp; YouTube player</body>';
        el.replaceWith(f); window.__yt = this; setTimeout(() => o.events.onReady({}), 10); }
        loadVideoById() { setTimeout(() => this.o.events.onStateChange({ data: 1 }), 20); }
        pauseVideo() { this.o.events.onStateChange({ data: 2 }); } playVideo() { this.o.events.onStateChange({ data: 1 }); }
        stopVideo() {} seekTo() {} getCurrentTime() { return 0; } } };
      window.onYouTubeIframeAPIReady();` }));
    const titles = ['Rainy Window', 'Slow Morning Coffee', 'Paper Lanterns', 'Night Bus', 'Moss and Stone', 'Late Library', 'Soft Static', 'Harbor Lights', 'Quiet Orbit', 'Warm Tape'];
    await p.route('https://www.googleapis.com/**', r => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith('/search')) return r.fulfill({ json: { items: titles.map((_, i) => ({ id: { videoId: 'v' + i } })) } });
      const ids = u.searchParams.get('id').split(',');
      return r.fulfill({ json: { items: ids.map(id => { const i = +id.slice(1); return { id, snippet: { title: titles[i] + ' (lofi)', channelTitle: 'Chill Beats Studio', liveBroadcastContent: 'none' }, contentDetails: { duration: `PT${2 + i % 3}M${10 + i * 4}S` }, status: { embeddable: true } }; }) } });
    });
    await p.addInitScript(() => { if (!localStorage.getItem('seeded')) { localStorage.setItem('seeded', '1');
      localStorage.setItem('pomodorify_hours', JSON.stringify({ 'Writing the design doc': 3.25, 'scotfree/pomodorify#19 Store the input list with built playlists': 1.5, 'Taxes': 0.75 })); } });
    await p.goto('http://127.0.0.1:8080/spotless/index.html');
    await p.waitForTimeout(600);

    // create from search
    await shot(p.locator('section.panel').nth(1), 'create-panel');
    await p.click('#search-open-button');
    await p.fill('#search-input', 'lofi beats');
    await p.fill('#search-name', 'Morning focus');
    await p.check('#opt-instrumental');
    await shot(p.locator('#search-dialog'), 'create-search');
    await p.click('#search-create-button');
    await p.waitForSelector('#playlist-screen:not([hidden])');
    await p.waitForTimeout(200);
    await shot(p.locator('.container'), 'create-playlist');
    await p.click('#playlist-back-button');

    // start a playlist
    await p.waitForTimeout(200);
    await shot(p.locator('#pomo-panel'), 'start-pick');
    await p.click('#start-button');
    await p.waitForTimeout(500);
    await p.click('#now-playing [data-action="next"]');
    await p.waitForTimeout(300);
    await shot(p.locator('#pomo-panel'), 'start-running');
    await shot(p.locator('#now-playing'), 'start-now-playing');
    await p.click('#running-stop-button');
    await p.click('#new-session-button');

    // local task
    await p.fill('#project-input', 'Writing the design doc');
    await p.click('#task-view-button');
    await p.fill('#labels-input', 'writing, planning');
    await shot(p.locator('#task-dialog'), 'task-popup');
    await p.keyboard.press('Escape');
    await shot(p.locator('#pomo-panel'), 'task-row');
    await shot(p.locator('section.panel').nth(2), 'task-totals');

    // github
    await p.evaluate(() => localStorage.setItem('track_github_token', 'ghp_example'));
    await p.reload();
    await p.waitForTimeout(800);
    await p.selectOption('#replay-select', { index: 1 });
    await p.click('#settings-open-button');
    await p.waitForTimeout(200);
    const dlg = p.locator('#settings-dialog');
    const box = await dlg.boundingBox();
    await p.screenshot({ path: `${OUT}/github-settings.jpg`, type: 'jpeg', quality: 82, clip: { x: box.x, y: box.y, width: box.width, height: 360 } });
    console.log('wrote github-settings');
    await p.keyboard.press('Escape');
    await p.click('#project-select-combo input');
    await p.keyboard.type('pomo');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(400);
    await p.click('#issue-select-combo input');
    await p.keyboard.type('help');
    await p.waitForTimeout(150);
    const pb = await p.locator('#pomo-panel').boundingBox();
    const lb = await p.locator('#issue-select-list').boundingBox();
    await p.screenshot({ path: `${OUT}/github-pick.jpg`, type: 'jpeg', quality: 82, clip: { x: pb.x, y: pb.y, width: pb.width, height: Math.max(pb.height, lb.y + lb.height - pb.y + 12) } });
    console.log('wrote github-pick');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(500);
    await shot(p.locator('#pomo-panel'), 'github-ready');
    await ctx.close();
  }

  // ---------- Track: Spotify login ----------
  {
    const ctx = await b.newContext({ viewport: { width: 760, height: 700 }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    await stubCommon(p);
    await p.goto('http://127.0.0.1:8080/track/index.html');
    await p.waitForTimeout(400);
    await shot(p.locator('.container'), 'spotify-login');
    await ctx.close();
  }
  await b.close();
})();
