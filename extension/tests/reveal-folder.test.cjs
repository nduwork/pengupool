const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the real command registry with only VS Code replaced.
function harness(options = {}) {
  const handlers = {}, opened = [], errors = [];
  const vscode = {
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: {
      registerCommand: (id, fn) => { handlers[id] = fn; return { dispose() {} }; },
      executeCommand: async (...args) => { opened.push(args); },
    },
    window: { showErrorMessage: (message) => errors.push(message) },
  };
  const filename = path.join(__dirname, '../src/commands.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, process,
    require: (id) => id === 'vscode' ? vscode : id === './util' ? {} : {},
  }, { filename });
  const context = { subscriptions: [], globalState: { get: () => undefined, update: async () => {} } };
  exports.registerCommands(context, {
    provider: { find: options.find ?? (() => undefined) },
    terminals: {},
    tree: { selection: [] },
    explorer: { follow: async () => {} },
    files: { refresh: () => {} },
  });
  return { handlers, opened, errors, vscode };
}

const node = { id: 's1', name: 'lead', cwd: '/repos/app/wt-lead' };

test('Reveal hands the session folder to the OS file manager', async () => {
  const h = harness();
  await h.handlers['pengupool.reveal'](node);
  assert.deepEqual(h.opened, [['revealFileInOS', { fsPath: '/repos/app/wt-lead' }]]);
  assert.deepEqual(h.errors, []);
});

test('Reveal accepts a session id the way the map and log panels send it', async () => {
  const h = harness({ find: (id) => (id === 's1' ? node : undefined) });
  await h.handlers['pengupool.reveal']('s1');
  assert.deepEqual(h.opened, [['revealFileInOS', { fsPath: '/repos/app/wt-lead' }]]);
});

test('Reveal reports a session that has no folder', async () => {
  const h = harness();
  await h.handlers['pengupool.reveal']({ id: 's1', name: 'lead', cwd: '' });
  assert.deepEqual(h.opened, []);
  assert.match(h.errors.at(-1), /"lead" has no folder to reveal/);
});

test('Reveal surfaces a file manager that refuses the path', async () => {
  const h = harness();
  h.vscode.commands.executeCommand = async () => { throw new Error('no such folder'); };
  await h.handlers['pengupool.reveal'](node);
  assert.match(h.errors.at(-1), /cannot open \/repos\/app\/wt-lead/);
  assert.match(h.errors.at(-1), /no such folder/);
});

test('Reveal with no session selected does nothing', async () => {
  const h = harness();
  await h.handlers['pengupool.reveal'](undefined);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.errors, []);
});
