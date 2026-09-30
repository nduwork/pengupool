const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function transpile(name) {
  const filename = path.join(__dirname, '../src', name + '.ts');
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
}

/** Fake window: roots the workspace has, what was asked of VS Code, and the remembered session root. */
function window(options = {}) {
  const calls = [], folders = (options.folders ?? []).map((fsPath) => ({
    uri: { fsPath, toString: () => 'file://' + fsPath },
  }));
  const saved = new Map(options.saved ?? []);
  const vscode = {
    Uri: { file: (fsPath) => ({ fsPath, toString: () => 'file://' + fsPath }) },
    commands: { executeCommand: async (...args) => { calls.push(['executeCommand', ...args]); } },
    workspace: {
      get configuration() { return undefined; },   // replaced below
      getConfiguration: () => ({ get: (key, fallback) => key === 'explorerSessionRoot'
        ? (options.roots ?? false) : (options.follow ?? fallback) }),
      get workspaceFolders() { return folders.length ? folders : undefined; },
      getWorkspaceFolder: (uri) => folders.find((folder) => uri.fsPath === folder.uri.fsPath
        || uri.fsPath.startsWith(folder.uri.fsPath + '/')),
      updateWorkspaceFolders: (start, deleteCount, ...added) => {
        calls.push(['updateWorkspaceFolders', start, deleteCount, ...added.map((f) => f.uri.fsPath)]);
        if (options.refuse) { return false; }
        if (deleteCount) { folders.splice(start, deleteCount); }
        folders.splice(start, 0, ...added);
        return true;
      },
    },
  };
  const state = {
    get: (key) => saved.get(key),
    update: async (key, value) => { saved.set(key, value); },
  };
  const exports = {};
  vm.runInNewContext(transpile('explorer'), {
    exports, require: (id) => (id === 'vscode' ? vscode : {}), setTimeout, Promise,
  }, { filename: 'explorer.ts' });
  return { follow: new exports.ExplorerFollow(state).follow.bind(new exports.ExplorerFollow(state)), calls, folders, saved };
}

const reveal = (calls) => calls.filter((call) => call[0] === 'executeCommand' && call[1] === 'revealInExplorer');
const folderChanges = (calls) => calls.filter((call) => call[0] === 'updateWorkspaceFolders');

test('a session folder inside the window is revealed without touching the workspace', async () => {
  const w = window({ folders: ['/repos/pool'], follow: true });
  await w.follow('/repos/pool/wt-lead');
  assert.equal(reveal(w.calls).length, 1);
  assert.deepEqual(folderChanges(w.calls), []);
  assert.equal(w.saved.size, 0);
});

test('a folder outside the window is left alone unless the window may take an extra root', async () => {
  const w = window({ folders: ['/repos/pool'], follow: true });
  await w.follow('/repos/other/wt-lead');
  assert.deepEqual(w.calls, []);            // no reveal, and above all no "UNTITLED (WORKSPACE)" window
  assert.equal(w.saved.size, 0);
});

test('a session folder outside the workspace is added and then revealed when that is opted in', async () => {
  const w = window({ folders: ['/repos/pool'], follow: true, roots: true });
  await w.follow('/repos/other/wt-lead');
  assert.deepEqual(folderChanges(w.calls), [['updateWorkspaceFolders', 1, 0, '/repos/other/wt-lead']]);
  assert.deepEqual(w.saved.get('pengupool.explorerSessionRoot'), 'file:///repos/other/wt-lead');
  // the root lands asynchronously, so the reveal has to wait for it
  assert.deepEqual(w.calls.map((call) => call[0]), ['updateWorkspaceFolders', 'executeCommand']);
});

test('the next session replaces the session root instead of piling up a second one', async () => {
  const w = window({
    folders: ['/repos/pool', '/repos/other/wt-lead'],
    saved: [['pengupool.explorerSessionRoot', 'file:///repos/other/wt-lead']],
    follow: true, roots: true,
  });
  await w.follow('/repos/third/wt-api');
  assert.deepEqual(folderChanges(w.calls), [['updateWorkspaceFolders', 1, 1, '/repos/third/wt-api']]);
  assert.deepEqual(w.folders.map((folder) => folder.uri.fsPath), ['/repos/pool', '/repos/third/wt-api']);
});

test('a session root the user removed is not resurrected, the new folder is appended', async () => {
  const w = window({
    folders: ['/repos/pool'],
    saved: [['pengupool.explorerSessionRoot', 'file:///repos/gone'] ],
    follow: true, roots: true,
  });
  await w.follow('/repos/other/wt-lead');
  assert.deepEqual(folderChanges(w.calls), [['updateWorkspaceFolders', 1, 0, '/repos/other/wt-lead']]);
  assert.equal(reveal(w.calls).length, 1);
});

test('an empty window takes the session folder as its root when that is opted in', async () => {
  const w = window({ folders: [], follow: true, roots: true });
  await w.follow('/repos/pool/wt-lead');
  assert.deepEqual(folderChanges(w.calls), [['updateWorkspaceFolders', 0, 0, '/repos/pool/wt-lead']]);
  assert.equal(reveal(w.calls).length, 1);
});

test('a refused folder is neither revealed nor remembered', async () => {
  const w = window({ folders: ['/repos/pool'], follow: true, roots: true, refuse: true });
  await w.follow('/repos/other/wt-lead');
  assert.deepEqual(reveal(w.calls), []);
  assert.equal(w.saved.size, 0);
});

test('turning explorerFollow off leaves the Explorer alone', async () => {
  const w = window({ folders: ['/repos/pool'], follow: false });
  await w.follow('/repos/pool/wt-lead');
  assert.deepEqual(w.calls, []);
});

test('a session without a folder is left alone', async () => {
  const w = window({ folders: ['/repos/pool'], follow: true });
  await w.follow('');
  assert.deepEqual(w.calls, []);
});

// --- the switch command wires it in, before the terminal takes focus -------------------------------

function commands(order) {
  const handlers = {};
  const vscode = {
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: { registerCommand: (id, fn) => { handlers[id] = fn; return { dispose() {} }; } },
    window: { showErrorMessage: () => {} },
  };
  const deps = {
    provider: { find: (id) => (id === 's1' ? { id: 's1', name: 'lead', cwd: '/repos/pool/wt-lead' } : undefined) },
    terminals: { switchTo: async () => { order.push('terminal'); return true; } },
    tree: { selection: [], reveal: async () => { order.push('sessions list'); } },
    explorer: { follow: async () => { order.push('explorer'); } },
  };
  const exports = {};
  vm.runInNewContext(transpile('commands'), {
    exports, process,
    require: (id) => {
      if (id === 'vscode') { return vscode; }
      if (id === './mapPanel') { return { MapPanel: { showIfOpen: () => undefined } }; }
      if (id === './logPanel') { return { LogPanel: { showIfOpen: () => undefined } }; }
      return {};
    },
  }, { filename: 'commands.ts' });
  exports.registerCommands({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } }, deps);
  return handlers;
}

test('opening a session reveals its folder, then focuses the terminal', async () => {
  const order = [];
  const handlers = commands(order);
  await handlers['pengupool.switch']('s1');
  assert.deepEqual(order, ['sessions list', 'explorer', 'terminal']);
});
