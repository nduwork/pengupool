const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

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
  vm.runInNewContext(code, {
    exports,
    require: (id) => id === 'vscode' ? vscode : id === './sessionState' ? state : {},
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

test('Sessions webview offers New and Add Previous from background right-click', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/sessionsView.ts'), 'utf8');
  assert.match(source, /addEventListener\('contextmenu'/);
  assert.match(source, /showMenu\(event, null\)/);
  assert.match(source, /pengupool\.new/);
  assert.match(source, /pengupool\.add/);
});

test('Sessions webview preserves row actions, keyboard activation, and drag grouping', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/sessionsView.ts'), 'utf8');
  for (const command of ['switch', 'reveal', 'openSessionWindow', 'group', 'rename', 'compact', 'restart', 'close']) {
    assert.match(source, new RegExp(`pengupool\\.${command}`));
  }
  assert.match(source, /addEventListener\('keydown'/);
  assert.match(source, /addEventListener\('dragstart'/);
  assert.match(source, /type:'group'/);
});

test('Sessions webview labels the reveal row for the platform file manager', () => {
  const view = loadSessionsView();
  assert.match(view.sessionsHtml(), /const revealLabel = "Reveal in Finder";/);
  const source = fs.readFileSync(path.join(__dirname, '../src/sessionsView.ts'), 'utf8');
  assert.match(source, /addMenuItem\(revealLabel, 'pengupool\.reveal'\)/);
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
