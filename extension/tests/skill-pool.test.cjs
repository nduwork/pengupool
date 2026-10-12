const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function transpile(name) {
  return ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
}

/** The map panel against a stubbed host; ctl answers from `answers` (keyed by the joined args). */
function openMap(answers, warningPick, ui = {}) {
  const commands = [], ctl = [], posted = [], shown = [];
  let receive;
  const webview = {
    cspSource: 'vscode-resource:', html: '', asWebviewUri: (uri) => uri,
    postMessage: async (m) => { posted.push(m); return true; },
    onDidReceiveMessage: (cb) => { receive = cb; return { dispose() {} }; },
  };
  const panel = { webview, reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }) };
  const vscode = {
    ViewColumn: { One: 1, Beside: -2 }, ProgressLocation: { Notification: 15 },
    Uri: { joinPath: (...parts) => parts.join('/'), file: (p) => ({ fsPath: p }) },
    commands: { executeCommand: async (...args) => { commands.push(args); } },
    window: {
      createWebviewPanel: () => panel,
      showErrorMessage: async (m) => { shown.push(['error', m]); },
      showInformationMessage: async (m) => { shown.push(['info', m]); },
      showWarningMessage: async (m, opts, ...items) => { shown.push(['warn', m]); return warningPick ? items[0] : undefined; },
      showOpenDialog: async () => [{ fsPath: ui.folder || '/repos/skills' }],
      showQuickPick: async (items) => { ui.offered = items.map((i) => i.label); return items.find((i) => i.label.includes(ui.pick || 'local')); },
      showInputBox: async () => ui.input,
      withProgress: async (o, task) => task(),
    },
  };
  const runCtl = async (args) => { ctl.push(args.join(' ')); return answers[args.join(' ')] || { code: 0, stdout: '', stderr: '' }; };
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) { return modules.get(name); }
    const exports = {};
    modules.set(name, exports);
    vm.runInNewContext(transpile(name), { exports, require }, { filename: name + '.ts' });
    return exports;
  }
  function require(id) {
    if (id === 'vscode') { return vscode; }
    if (id === './harness') { return load('harness'); }
    if (id === './webviewMenu') { return load('webviewMenu'); }
    if (id === './util') { return { REVEAL_LABEL: 'Reveal in Finder', runCtl }; }
    if (id === './serveClient') { return {}; }
    if (id === './sessionState') {
      const state = load('sessionState');
      return { SESSION_STATES: {}, SESSION_STATE_CSS: '', CTX_LEVEL_JS: state.CTX_LEVEL_JS, CTX_LEVEL_CSS: '' };
    }
    throw new Error('Unexpected dependency: ' + id);
  }
  const snap = { topo_hash: 'h', roots: [{ id: 's1', name: 'a', cwd: '/repos/skills/wt', children: [] }], cross: [], msgs: [] };
  load('mapPanel').MapPanel.show({ extensionUri: 'ext' }, snap);
  return { receive, commands, ctl, posted, shown, html: () => webview.html };
}
const settle = async () => { for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 0)); } };
const LS = { code: 0, stdout: '[{"repo":"/repos/skills","name":"skills","worktrees":[]}]', stderr: '' };

test('the map sends the pool when ready, and a drop starts a session in that repo', async () => {
  const map = openMap({ 'pool ls': LS });
  map.receive({ type: 'ready' });
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(map.posted.find((m) => m.type === 'pool'))), { type: 'pool', repos: [{ repo: '/repos/skills', name: 'skills', worktrees: [] }] });
  map.receive({ type: 'poolDrop', dir: '/repos/skills' });
  await settle();
  assert.deepEqual(map.commands.at(-1), ['pengupool.newIn', '/repos/skills']);
});

test('Add skill repo picks a folder, adds it, and reloads the pool', async () => {
  const map = openMap({ 'pool ls': LS });
  map.receive({ type: 'poolAdd' });
  await settle();
  assert.deepEqual(map.ctl, ['pool add /repos/skills', 'pool ls']);
});

test('a refused pool action shows its reason', async () => {
  const map = openMap({ 'pool add /repos/skills': { code: 3, stdout: '', stderr: '/repos/skills has no GitHub origin' } });
  map.receive({ type: 'poolAdd' });
  await settle();
  assert.deepEqual(map.shown, [['error', 'PenguPool: /repos/skills has no GitHub origin']]);
});

test('an unmerged worktree asks first; yes merges, releases and removes', async () => {
  const answers = {
    'pool ls': LS,
    'worktree-rm /wt': { code: 4, stdout: '', stderr: 'pengupool/x is not merged to main' },
    'worktree-rm /wt --merge': { code: 0, stdout: 'removed /wt; released v2026.10.10', stderr: '' },
  };
  const yes = openMap(answers, true);
  yes.receive({ type: 'worktreeRm', path: '/wt' });
  await settle();
  assert.deepEqual(yes.ctl.filter((c) => c.startsWith('worktree-rm')), ['worktree-rm /wt', 'worktree-rm /wt --merge']);
  assert.ok(yes.shown.some(([k, m]) => k === 'warn' && /not merged/.test(m)));
  assert.ok(yes.shown.some(([k, m]) => k === 'info' && /released v2026\.10\.10/.test(m)));
  const no = openMap(answers, false);
  no.receive({ type: 'worktreeRm', path: '/wt' });
  await settle();
  assert.deepEqual(no.ctl.filter((c) => c.startsWith('worktree-rm')), ['worktree-rm /wt']);
  assert.ok(!no.shown.some(([k]) => k === 'error'), 'exit 4 is a question, not an error');
});

test('the drawer script parses, and a drop counts on the empty map too', () => {
  const html = openMap({}).html();
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(html, /id="poolToggle"[^>]*aria-expanded/);
  assert.match(script, /wrap\.contains\(t\) \|\| t\.id==='empty'/);
});

test('newSession takes a preset folder and skips the folder picker', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/commands.ts'), 'utf8');
  assert.match(source, /const newSession = async \(parent\?: SessionNode, preset\?: string\)/);
  assert.match(source, /reg\('pengupool\.newIn', \(dir: string, parent\?: string\) =>\s+newSession\(parent \? d\.provider\.all\.find\(\(n\) => n\.id === parent\) : undefined, dir\)\)/);
});

test('a second Remove while the first still runs is ignored', async () => {
  const map = openMap({ 'worktree-rm /wt': { code: 4, stdout: '', stderr: 'pengupool/x is not merged to main' } }, true);
  map.receive({ type: 'worktreeRm', path: '/wt' });
  map.receive({ type: 'worktreeRm', path: '/wt' });
  await settle();
  assert.deepEqual(map.ctl.filter((c) => c.startsWith('worktree-rm')), ['worktree-rm /wt', 'worktree-rm /wt --merge']);
  map.receive({ type: 'worktreeRm', path: '/wt' });   // done: a later click runs again
  await settle();
  assert.equal(map.ctl.filter((c) => c === 'worktree-rm /wt').length, 2);
});

test('Add skill repo from GitHub asks for the repo and a parent folder, then clones it', async () => {
  const map = openMap({ 'pool ls': LS }, false, { pick: 'GitHub', input: 'me/skills', folder: '/repos' });
  map.receive({ type: 'poolAdd' });
  await settle();
  assert.deepEqual(map.ctl, ['pool clone me/skills /repos', 'pool ls']);
});

test('Add from GitHub cancelled at the repo prompt does nothing', async () => {
  const map = openMap({}, false, { pick: 'GitHub' });
  map.receive({ type: 'poolAdd' });
  await settle();
  assert.deepEqual(map.ctl, []);
});

test('a session card dropped on the drawer adds its repo', async () => {
  const map = openMap({ 'pool ls': LS });
  map.receive({ type: 'poolSession', id: 's1' });
  map.receive({ type: 'poolSession', id: 'gone' });
  await settle();
  assert.deepEqual(map.ctl, ['pool add /repos/skills/wt', 'pool ls']);
  const script = [...map.html().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  assert.match(script, /type:'poolSession', id:d\.id/);
});

test('a pool repo that is not a skill repo is tagged, and its worktree × says merge first on GitHub', () => {
  const script = [...openMap({}).html().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  assert.match(script, /const plain = r\.skill === false && !r\.missing/);
  assert.match(script, /never merges or releases it/);
  assert.match(script, /once its PR is merged on GitHub/);
});

test('a repo dropped on a session card starts a child of that session', async () => {
  const map = openMap({ 'pool ls': LS });
  map.receive({ type: 'poolDrop', dir: '/repos/skills', parent: 'sid-1' });
  await settle();
  assert.deepEqual(map.commands.at(-1), ['pengupool.newIn', '/repos/skills', 'sid-1']);
  assert.match(map.html(), /type:'poolDrop', dir:d\.dir, parent:/);
});

test('a drop reloads the pool once the session has started, so a new worktree shows', async () => {
  const map = openMap({ 'pool ls': LS });
  map.receive({ type: 'poolDrop', dir: '/repos/skills' });
  await settle();
  assert.deepEqual(map.ctl, ['pool ls']);
});

test('the repo menu offers release only for a skill repo', async () => {
  const skill = {}, plain = {};
  openMap({ 'pool ls': LS }, false, skill).receive({ type: 'poolMenu', dir: '/repos/skills', skill: true });
  openMap({ 'pool ls': LS }, false, plain).receive({ type: 'poolMenu', dir: '/repos/runners', skill: false });
  await settle();
  assert.deepEqual([...skill.offered], ['New session here', 'Open folder in new window', 'Pull latest', 'Release…', 'Remove from pool']);
  assert.ok(!plain.offered.includes('Release…'));
});

test('repo menu actions run the matching ctl verb or command', async () => {
  const run = async (pick, warningPick) => {
    const ui = { pick };
    const map = openMap({ 'pool ls': LS, 'pool pull /repos/skills': { code: 0, stdout: 'skills: 2 new commit(s)', stderr: '' } }, warningPick, ui);
    map.receive({ type: 'poolMenu', dir: '/repos/skills', skill: true });
    await settle();
    return map;
  };
  assert.deepEqual((await run('New session')).commands.at(-1), ['pengupool.newIn', '/repos/skills']);
  const open = (await run('Open folder')).commands.at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify([open[0], open[1].fsPath, open[2]])), ['vscode.openFolder', '/repos/skills', { forceNewWindow: true }]);
  const pulled = await run('Pull');
  assert.deepEqual(pulled.ctl, ['pool pull /repos/skills', 'pool ls']);
  assert.deepEqual(pulled.shown.at(-1), ['info', 'PenguPool: skills: 2 new commit(s)']);
  assert.deepEqual((await run('Remove')).ctl, ['pool rm /repos/skills', 'pool ls']);
  assert.deepEqual((await run('Release', false)).ctl, []);                 // the confirmation is the approval
  assert.deepEqual((await run('Release', true)).ctl, ['release /repos/skills', 'pool ls']);
});

test('the drawer is the Agent pool, with release, live sessions and a menu on each repo', () => {
  const html = openMap({}).html();
  assert.match(html, />Agent pool</);
  assert.match(html, /r\.version/);
  assert.match(html, /type:'poolMenu'/);
  assert.match(html, /contextmenu/);
  assert.match(html, /liveIn\(/);
});

test('the Agent pool panel has a drag handle that sets and remembers its width', () => {
  const html = openMap({}).html();
  assert.match(html, /id="poolGrip"/);
  assert.match(html, /poolWidth/);
  assert.match(html, /function setPoolWidth/);
  assert.match(html, /vscode\.setState\?\.\(\{[^}]*poolWidth/);
});
