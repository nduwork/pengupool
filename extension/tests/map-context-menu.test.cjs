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
  const panel = { webview, reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }) };
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
  return { receive, commands, html: webview.html };
}

test('the map webview script parses with the shared menu in place', () => {
  const { html } = openMap({ topo_hash: 'h', roots: [] });
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(html, /id="menu"/);
  assert.match(script, /function showMenu/);
  assert.match(script, /function hideMenu/);
  assert.match(script, /const revealLabel = "Reveal in Finder";/);
});

test('a map card and the empty canvas both open the shared menu', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/mapPanel.ts'), 'utf8');
  assert.match(source, /MENU_CSS/);
  assert.match(source, /MENU_HTML/);
  assert.match(source, /MENU_JS/);
  assert.match(source, /grp\.addEventListener\('contextmenu', event => \{/);
  assert.match(source, /showMenu\(event, n\.id, revealLabel\)/);
  assert.match(source, /document\.getElementById\('wrap'\)\.addEventListener\('contextmenu'/);
  assert.match(source, /if\(!event\.target\.closest\('\.node'\)\) showMenu\(event, null, revealLabel\)/);
});

test('a map menu command runs the session command with the node, like the list', async () => {
  const node = { id: 's1', name: 'lead', cwd: '/repos/app', children: [] };
  const map = openMap({ topo_hash: 'h', roots: [node] });
  map.receive({ type: 'command', command: 'pengupool.reveal', id: 's1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(map.commands.at(-1), ['pengupool.reveal', node]);
});

test('a map menu command outside the shared allowlist is ignored', async () => {
  const node = { id: 's1', name: 'lead', children: [] };
  const map = openMap({ topo_hash: 'h', roots: [node] });
  map.receive({ type: 'command', command: 'workbench.action.terminal.killAll', id: 's1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(map.commands, []);
});

test('both webviews take the menu and its allowlist from the shared module', () => {
  for (const file of ['mapPanel.ts', 'sessionsView.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
    assert.match(source, /from '\.\/webviewMenu'/);
    assert.doesNotMatch(source, /addMenuItem\(/);            // the item list exists once
    assert.doesNotMatch(source, /new Set\(\['pengupool\./); // and so does the host-side allowlist
  }
});
