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

/** Open a map panel against a stubbed host and hand back the panel's message handler, the commands it ran,
 *  and the webview HTML it built. The shared menu loads for real, so the allowlist under test is the
 *  shipped one. */
function openMap(snapshot) {
  const commands = [];
  let receive;
  const webview = {
    cspSource: 'vscode-resource:',
    html: '',
    asWebviewUri: (uri) => uri,
    postMessage: async () => true,
    onDidReceiveMessage: (callback) => { receive = callback; return { dispose() {} }; },
  };
  let disposed;
  const panel = { webview, reveal() {}, dispose() {}, onDidDispose: (callback) => { disposed = callback; return { dispose() {} }; } };
  const vscode = {
    ViewColumn: { One: 1, Beside: -2 },
    Uri: { joinPath: (...parts) => parts.join('/') },
    commands: { executeCommand: async (...args) => { commands.push(args); } },
    window: { createWebviewPanel: () => panel },
  };
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
    if (id === './util') { return { REVEAL_LABEL: 'Reveal in Finder' }; }
    if (id === './serveClient') { return {}; }
    if (id === './sessionState') {
      const state = load('sessionState');
      return { SESSION_STATES: {}, SESSION_STATE_CSS: '', CTX_LEVEL_JS: state.CTX_LEVEL_JS, CTX_LEVEL_CSS: '' };
    }
    throw new Error('Unexpected dependency: ' + id);
  }
  load('mapPanel').MapPanel.show({ extensionUri: 'ext' }, snapshot);
  return { receive, commands, html: webview.html, dispose: () => disposed() };
}

test('the map webview script parses with the session tags in place', () => {
  const { html } = openMap({ topo_hash: 'h', roots: [] });
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(html, /id="menu"/, 'no menu of its own: VS Code draws it, above every panel');
  assert.match(script, /function sessionContext/);
  assert.match(script, /function poolContext/);
});

test('a map card is tagged with its session and whether it folds; the canvas as the pool', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/mapPanel.ts'), 'utf8');
  assert.match(source, /sessionContext\(grp, n\.id, \{ foldable: !!n\.folds, folded: folded\.has\(n\.id\) \}\)/);
  assert.match(source, /poolContext\(document\.body, \{ map: true \}\)/);
  const menu = fs.readFileSync(path.join(__dirname, '../src/webviewMenu.ts'), 'utf8');
  assert.match(menu, /webviewSection:'session', sessionId:id, preventDefaultContextMenuItems:true/);
  assert.match(menu, /webviewSection:'pool', preventDefaultContextMenuItems:true/);
});

test('a command message from the map is no longer run: the menu is VS Code\'s', async () => {
  const node = { id: 's1', name: 'lead', children: [] };
  const map = openMap({ topo_hash: 'h', roots: [node] });
  map.receive({ type: 'command', command: 'pengupool.reveal', id: 's1' });
  map.receive({ type: 'command', command: 'workbench.action.terminal.killAll', id: 's1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(map.commands, []);
});
test('the map reports its fold state so the background menu offers only one of the pair', async () => {
  const map = openMap({ topo_hash: 'h', roots: [] });
  map.receive({ type: 'foldState', fold: 'folded' });
  map.receive({ type: 'foldState', fold: 'everything' });   // not a known state: no context to set
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(map.commands, [['setContext', 'pengupool.mapFold', 'folded']]);
  const source = fs.readFileSync(path.join(__dirname, '../src/mapPanel.ts'), 'utf8');
  assert.match(source, /const fold = !groups\.length \? 'none' : groups\.every\(n => folded\.has\(n\.id\)\) \? 'folded' : 'open';/,
    'no groups offers neither; folding every group means every group with children is folded');
  assert.match(source, /if\(fold !== reportedFold\)\{ reportedFold = fold; vscode\.postMessage\(\{type:'foldState', fold\}\); \}/,
    'report each change, not every tick');
});
test('closing the map clears its fold state, so the next map does not inherit it', async () => {
  const map = openMap({ topo_hash: 'h', roots: [] });
  map.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(map.commands, [['setContext', 'pengupool.mapFold', 'none']]);
});

/** commands.ts against stubs, recording what Fold and the session commands reach. */
function commandsWith(record) {
  const handlers = {};
  const vscode = {
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: { registerCommand: (id, fn) => { handlers[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
    window: { showErrorMessage: () => {} },
    env: { clipboard: { writeText: async (text) => record.push(['copy', text]) } },
  };
  const node = { id: 's1', name: 'lead', cwd: '/repos/app' };
  const deps = { provider: { find: (id) => (id === 's1' ? node : undefined) }, terminals: {}, tree: { selection: [] }, explorer: {} };
  const mod = {};
  vm.runInNewContext(transpile('commands'), {
    exports: mod, process,
    require: (id) => {
      if (id === 'vscode') { return vscode; }
      if (id === './mapPanel') { return { MapPanel: { showIfOpen: () => ({ fold: (...a) => record.push(['map', ...a]) }) } }; }
      if (id === './sessionsView') { return { SessionsView: { fold: (...a) => record.push(['list', ...a]) } }; }
      if (id === './logPanel') { return { LogPanel: { showIfOpen: () => undefined } }; }
      return {};
    },
  }, { filename: 'commands.ts' });
  mod.registerCommands({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } }, deps);
  return handlers;
}

test('Fold and Unfold act in the view the menu opened in; Fold All folds every map group', async () => {
  const record = [];
  const h = commandsWith(record);
  h['pengupool.fold']({ webview: 'pengupoolMap', webviewSection: 'session', sessionId: 's1' });
  h['pengupool.unfold']({ webview: 'pengupoolSessions', webviewSection: 'session', sessionId: 's1' });
  h['pengupool.foldAll']({ webview: 'pengupoolMap', webviewSection: 'pool' });
  h['pengupool.unfoldAll']();
  assert.deepEqual(record, [['map', 's1', true], ['list', 's1', false], ['map', '', true], ['map', '', false]]);
});

test('a session command run from the native menu finds its session by the tag', async () => {
  const record = [];
  const h = commandsWith(record);
  await h['pengupool.copyPath']({ webview: 'pengupoolMap', webviewSection: 'session', sessionId: 's1' });
  assert.deepEqual(record, [['copy', '/repos/app']]);
});

test('the map folds when the host says so, and folding saves', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/mapPanel.ts'), 'utf8');
  assert.match(source, /if\(ev\.data\?\.type==='fold'\)\{ ev\.data\.id \? setFold\(ev\.data\.id, ev\.data\.on\) : foldAll\(ev\.data\.on\); return; \}/);
  assert.match(source, /function setFold\(id, on\)\{[^}]*save\(\); redraw\(\); \}/);
});
