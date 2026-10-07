const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/** The shared menu module, transpiled for real: the item list and the host-side allowlist under test are
 *  the shipped ones, not a stub. */
function loadSharedMenu(vscode) {
  const filename = path.join(__dirname, '../src/webviewMenu.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: (id) => id === 'vscode' ? vscode : {} }, { filename });
  return exports;
}

function loadSessionsView() {
  const filename = path.join(__dirname, '../src/sessionsView.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  const commands = [];
  const state = {
    SESSION_STATES: { active: { symbol: '●', label: 'Active' } },
    SESSION_STATE_CSS: '',
  };
  const vscode = {
    EventEmitter: class {
      listeners = [];
      event = (fn) => { this.listeners.push(fn); return { dispose() {} }; };
      fire(value) { this.listeners.forEach((fn) => fn(value)); }
      dispose() {}
    },
    commands: { executeCommand: async (...args) => { commands.push(args); } },
  };
  const menu = loadSharedMenu(vscode);
  vm.runInNewContext(code, {
    exports,
    require: (id) => id === 'vscode' ? vscode
      : id === './sessionState' ? state
      : id === './webviewMenu' ? menu
      : id === './util' ? { REVEAL_LABEL: 'Reveal in Finder' }
      : {},
  }, { filename });
  return { ...exports, commands };
}

test('Sessions webview script parses so snapshots can populate the panel', () => {
  const html = loadSessionsView().sessionsHtml();
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  assert.doesNotThrow(() => new vm.Script(script));
});

test('an initially visible Sessions view announces visibility to the layout', () => {
  const { SessionsView } = loadSessionsView();
  const sessions = new SessionsView({ find() {} });
  const events = [];
  sessions.onDidChangeVisibility((event) => events.push(event.visible));
  sessions.resolveWebviewView({
    visible: true,
    webview: { onDidReceiveMessage: () => ({ dispose() {} }) },
    onDidChangeVisibility: () => ({ dispose() {} }),
  });
  assert.equal(events.at(-1), true);
});

test('Sessions webview offers the shared menu from a background right-click', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/sessionsView.ts'), 'utf8');
  assert.match(source, /addEventListener\('contextmenu'/);
  assert.match(source, /showMenu\(event, null, revealLabel\)/);
  assert.match(source, /MENU_CSS/);
  assert.match(source, /MENU_HTML/);
  assert.match(source, /MENU_JS/);
});

test('the shared menu offers the pool actions, the session actions, and no native item', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/webviewMenu.ts'), 'utf8');
  assert.match(source, /addMenuItem\('New Session', 'pengupool\.new', 'add', 'N'\)/);
  assert.match(source, /addMenuItem\('Add Previous Session…', 'pengupool\.add', 'history', 'A'\)/);
  assert.match(source, /addMenuItem\('Resume Previous Sessions…', 'pengupool\.resumePrevious', 'run-all'\)/);
  for (const command of ['newChild', 'addChild', 'reveal', 'copyPath', 'group', 'rename', 'describe', 'compact',
    'clear', 'restart', 'close']) {
    assert.match(source, new RegExp(`'pengupool\\.${command}'`));
  }
  // a click opens a session, so the menu no longer repeats it
  assert.doesNotMatch(source, /'pengupool\.switch'/);
  // on a session: add as its child, then folder, the session operations, its place and name, close
  const order = [...source.slice(source.indexOf('if(id){')).matchAll(/addMenuItem\([^,]+, '(pengupool\.\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(order, ['pengupool.newChild', 'pengupool.addChild', 'pengupool.new', 'pengupool.add',
    'pengupool.resumePrevious', 'pengupool.reveal', 'pengupool.copyPath', 'pengupool.compact', 'pengupool.clear',
    'pengupool.restart', 'pengupool.group', 'pengupool.rename', 'pengupool.describe', 'pengupool.close']);
  assert.match(source, /new Set\(\['pengupool\.new', 'pengupool\.add', 'pengupool\.resumePrevious'\]\)/);
  // The system cut/copy/paste menu is suppressed, so one right-click never leaves two menus behind.
  assert.match(source, /addEventListener\('contextmenu',event=>\{ if\(!event\.defaultPrevented\) event\.preventDefault\(\); \}\)/);
});

test('every menu item has an icon, and each item with a Sessions key shows that key', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/webviewMenu.ts'), 'utf8');
  const icons = source.slice(source.indexOf('const MENU_ICONS'), source.indexOf('function hideMenu'));
  const items = [...source.matchAll(/addMenuItem\([^,]+, '(pengupool\.\w+)', '([\w-]+)'(?:, '([^']*)')?/g)];
  assert.equal(items.length, 14);
  for (const [, , icon] of items) { assert.ok(icons.includes(`${icon.includes('-') ? `'${icon}'` : icon}:`), `no icon ${icon}`); }
  const keys = Object.fromEntries(items.map(([, cmd, , key]) => [cmd, key]));
  const manifest = require('../package.json');
  for (const binding of manifest.contributes.keybindings.filter((b) => /pengupoolSessions/.test(b.when))) {
    const shown = binding.key.replace('shift+', '⇧').toUpperCase();
    assert.equal(keys[binding.command], shown, `${binding.command} should show ${shown}`);
  }
  assert.match(source, /addMenuItem\('Close', 'pengupool\.close', 'close', 'X', true\)/);
});

test('arrow keys, Home and End move focus through the menu', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/webviewMenu.ts'), 'utf8');
  assert.match(source, /\{ArrowDown:at\+1, ArrowUp:at-1, Home:0, End:items\.length-1\}/);
});

test('Sessions webview preserves keyboard activation and drag grouping', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/sessionsView.ts'), 'utf8');
  assert.match(source, /addEventListener\('keydown'/);
  assert.match(source, /addEventListener\('dragstart'/);
  assert.match(source, /type:'group'/);
  // A row highlights itself before the shared menu opens, so the menu's target is visible.
  assert.match(source, /addEventListener\('contextmenu',event=>\{ select\(node\.id\); showMenu\(event,node\.id,revealLabel\); \}\)/);
});

test('both webviews label the reveal row for the platform file manager', () => {
  const view = loadSessionsView();
  assert.match(view.sessionsHtml(), /const revealLabel = "Reveal in Finder";/);
  const menu = fs.readFileSync(path.join(__dirname, '../src/webviewMenu.ts'), 'utf8');
  assert.match(menu, /addMenuItem\(revealLabel, 'pengupool\.reveal', 'folder'\)/);
  const map = fs.readFileSync(path.join(__dirname, '../src/mapPanel.ts'), 'utf8');
  assert.match(map, /const revealLabel = \$\{JSON\.stringify\(REVEAL_LABEL\)\}/);
});

test('Sessions webview forwards Reveal with the session node, like the other row actions', async () => {
  const view = loadSessionsView();
  const node = { id: 's1', name: 'lead', cwd: '/repos/app', children: [] };
  const sessions = new view.SessionsView({ find: (id) => (id === 's1' ? node : undefined) });
  let receive;
  sessions.resolveWebviewView({
    visible: true,
    webview: { onDidReceiveMessage: (callback) => { receive = callback; return { dispose() {} }; } },
    onDidChangeVisibility: () => ({ dispose() {} }),
  });
  receive({ type: 'command', command: 'pengupool.reveal', id: 's1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(view.commands.at(-1), ['pengupool.reveal', node]);
});

test('clicking a Sessions row opens that session', async () => {
  const view = loadSessionsView();
  const node = { id: 's1', name: 'lead', children: [] };
  const sessions = new view.SessionsView({ find: (id) => (id === 's1' ? node : undefined) });
  let receive;
  sessions.resolveWebviewView({
    visible: true,
    webview: { onDidReceiveMessage: (callback) => { receive = callback; return { dispose() {} }; } },
    onDidChangeVisibility: () => ({ dispose() {} }),
  });
  // the row posts `open`, not a menu command: switching is not on the menu's allowlist
  assert.match(view.sessionsHtml(), /row\.addEventListener\('click',\(\)=>\{ select\(node\.id,false\); vscode\.postMessage\(\{type:'open',id:node\.id\}\); \}\)/);
  receive({ type: 'open', id: 's1' });
  receive({ type: 'open', id: 'gone' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(view.commands, [['pengupool.switch', 's1']]);
});
