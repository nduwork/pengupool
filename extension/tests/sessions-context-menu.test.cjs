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

test('Sessions rows and background carry VS Code menu tags, and a row tag says whether it folds', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/sessionsView.ts'), 'utf8');
  assert.match(source, /SESSION_CONTEXT_JS/);
  assert.doesNotMatch(source, /showMenu|MENU_HTML/, 'no menu of its own');
  assert.match(source, /sessionContext\(row,node\.id,\{foldable:node\.children\.length>0,folded:collapsed\.has\(node\.id\)\}\)/);
  assert.match(source, /poolContext\(document\.body\)/);
  // a right-click highlights the row under VS Code's menu
  assert.match(source, /row\.addEventListener\('contextmenu',\(\)=>select\(node\.id\)\)/);
});

test('the list folds a row when the host says so', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/sessionsView.ts'), 'utf8');
  assert.match(source, /if\(event\.data\?\.type==='fold'\)\{ event\.data\.on\?collapsed\.add\(event\.data\.id\):collapsed\.delete\(event\.data\.id\); if\(shown\) render\(shown\); return; \}/);
  const view = loadSessionsView();
  const posted = [];
  const sessions = new view.SessionsView({ find() {} });
  sessions.resolveWebviewView({
    visible: true,
    webview: { onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async (m) => posted.push(m) },
    onDidChangeVisibility: () => ({ dispose() {} }),
  });
  view.SessionsView.fold('s1', true);
  assert.equal(JSON.stringify(posted), JSON.stringify([{ type: 'fold', id: 's1', on: true }]));
});

test('Sessions webview preserves keyboard activation and drag grouping', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/sessionsView.ts'), 'utf8');
  assert.match(source, /addEventListener\('keydown'/);
  assert.match(source, /addEventListener\('dragstart'/);
  assert.match(source, /type:'group'/);
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
