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
  assert.match(source, /addMenuItem\('New Session', 'pengupool\.new'\)/);
  assert.match(source, /addMenuItem\('Add Previous Session…', 'pengupool\.add'\)/);
  assert.match(source, /addMenuItem\('Resume Previous Sessions…', 'pengupool\.resumePrevious'\)/);
  for (const command of ['switch', 'reveal', 'group', 'rename', 'describe', 'compact', 'restart', 'close']) {
    assert.match(source, new RegExp(`'pengupool\\.${command}'`));
  }
  assert.match(source, /new Set\(\['pengupool\.new', 'pengupool\.add', 'pengupool\.resumePrevious'\]\)/);
  // The system cut/copy/paste menu is suppressed, so one right-click never leaves two menus behind.
  assert.match(source, /addEventListener\('contextmenu',event=>\{ if\(!event\.defaultPrevented\) event\.preventDefault\(\); \}\)/);
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
  assert.match(menu, /addMenuItem\(revealLabel, 'pengupool\.reveal'\)/);
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
