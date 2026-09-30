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

/** Fake window: its roots, what was asked of VS Code, and whether following is on. */
function window(options = {}) {
  const calls = [], folders = (options.folders ?? []).map((fsPath) => ({
    uri: { fsPath, toString: () => 'file://' + fsPath },
  }));
  const vscode = {
    Uri: { file: (fsPath) => ({ fsPath, toString: () => 'file://' + fsPath }) },
    commands: { executeCommand: async (...args) => { calls.push(['executeCommand', ...args]); } },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => key === 'explorerFollow' ? (options.follow ?? fallback) : fallback }),
      get workspaceFolders() { return folders.length ? folders : undefined; },
      getWorkspaceFolder: (uri) => folders.find((folder) => uri.fsPath === folder.uri.fsPath
        || uri.fsPath.startsWith(folder.uri.fsPath + '/')),
      // Nothing may ever change this window's workspace: the pool only reveals what is already in it.
      updateWorkspaceFolders: (...args) => { calls.push(['updateWorkspaceFolders', ...args.slice(0, 2)]); return true; },
    },
  };
  const exports = {};
  vm.runInNewContext(transpile('explorer'), {
    exports, require: (id) => (id === 'vscode' ? vscode : {}), setTimeout, Promise,
  }, { filename: 'explorer.ts' });
  return { follow: new exports.ExplorerFollow().follow.bind(new exports.ExplorerFollow()), calls };
}

const revealed = (calls) => calls.filter((call) => call[0] === 'executeCommand' && call[1] === 'revealInExplorer');

test('a session folder inside the window is revealed', async () => {
  const w = window({ folders: ['/repos/pool'] });
  await w.follow('/repos/pool/wt-lead');
  assert.equal(revealed(w.calls).length, 1);
  assert.deepEqual(w.calls.map((call) => call[0]), ['executeCommand']);
});

test('a folder outside the window is left alone: nothing added, reloaded or opened', async () => {
  const w = window({ folders: ['/repos/pool'] });
  await w.follow('/repos/other/wt-lead');
  assert.deepEqual(w.calls, []);
});

test('turning explorerFollow off leaves the Explorer alone, even for a folder it has', async () => {
  const w = window({ folders: ['/repos/pool'], follow: false });
  await w.follow('/repos/pool/wt-lead');
  assert.deepEqual(w.calls, []);
});

test('a session without a folder is left alone', async () => {
  const w = window({ folders: ['/repos/pool'] });
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
  const mod = {};
  vm.runInNewContext(transpile('commands'), {
    exports: mod, process,
    require: (id) => {
      if (id === 'vscode') { return vscode; }
      if (id === './mapPanel') { return { MapPanel: { showIfOpen: () => undefined } }; }
      if (id === './logPanel') { return { LogPanel: { showIfOpen: () => undefined } }; }
      return {};
    },
  }, { filename: 'commands.ts' });
  mod.registerCommands({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } }, deps);
  return handlers;
}

test('opening a session reveals its folder, then focuses the terminal', async () => {
  const order = [];
  const handlers = commands(order);
  await handlers['pengupool.switch']('s1');
  assert.deepEqual(order, ['sessions list', 'explorer', 'terminal']);
});
