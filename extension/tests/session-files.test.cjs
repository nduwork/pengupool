const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/** The real provider with VS Code replaced; the filesystem is real, in a temp folder. */
function load() {
  const filename = path.join(__dirname, '../src/sessionFiles.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const vscode = {
    Uri: { file: (fsPath) => ({ fsPath, toString: () => 'file://' + fsPath }) },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: class {
      listeners = [];
      event = (fn) => { this.listeners.push(fn); return { dispose() {} }; };
      fire(value) { this.listeners.forEach((fn) => fn(value)); }
      dispose() {}
    },
    TreeItem: class {
      constructor(labelOrUri, collapsibleState) {
        this.labelOrUri = labelOrUri;
        this.collapsibleState = collapsibleState;
        this.id = undefined;
        this.command = undefined;
        this.tooltip = undefined;
        this.resourceUri = labelOrUri?.fsPath ? labelOrUri : undefined;   // the Uri overload
      }
    },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, Promise, console,
    require: (id) => (id === 'vscode' ? vscode : id === 'fs' ? fs : id === 'path' ? path : {}),
  }, { filename });
  return { ...exports, vscode };
}

function folder(entries = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgfiles-'));
  for (const entry of entries) {
    const name = entry.replace(/\/$/, '');
    if (entry.endsWith('/')) { fs.mkdirSync(path.join(dir, name)); } else { fs.writeFileSync(path.join(dir, name), 'x'); }
  }
  return dir;
}

// cross-realm arrays are not reference-equal to ours: spread them into this realm before comparing
const names = (nodes) => [...nodes].map((node) => node.name);
const list = (nodes) => [...nodes].map((node) => ({ path: node.path, dir: node.dir }));

test('the tree is rooted at the selected session folder', async () => {
  const { SessionFilesProvider } = load();
  const dir = folder();
  const roots = await new SessionFilesProvider(() => ({ cwd: dir, name: 'lead' })).getChildren();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].path, dir);
  assert.equal(roots[0].dir, true);
  assert.equal(roots[0].name, path.basename(dir));
});

test('a session with no folder, or none selected, shows nothing', async () => {
  const { SessionFilesProvider } = load();
  assert.deepEqual(list(await new SessionFilesProvider(() => undefined).getChildren()), []);
  assert.deepEqual(list(await new SessionFilesProvider(() => ({ cwd: '', name: 'lead' })).getChildren()), []);
});

test('folders come first, then files, and .git is not listed', async () => {
  const { SessionFilesProvider } = load();
  const dir = folder(['.git/', '.DS_Store', 'b.txt', 'a.txt', 'src/']);
  const provider = new SessionFilesProvider(() => ({ cwd: dir, name: 'lead' }));
  const [root] = await provider.getChildren();
  const children = await provider.getChildren(root);
  assert.deepEqual(names(children), ['src', 'a.txt', 'b.txt']);
  assert.deepEqual(children.map((node) => node.dir), [true, false, false]);
});

test('clicking a file uses the same open-a-path action a terminal link does', async () => {
  const { SessionFilesProvider } = load();
  const provider = new SessionFilesProvider(() => undefined);
  const file = { path: '/repos/pool/wt-lead/README.md', name: 'README.md', dir: false };
  const item = provider.getTreeItem(file);
  assert.equal(item.id, file.path);
  assert.equal(item.command.command, 'vscode.open');
  assert.equal(item.command.arguments[0].fsPath, file.path);
  assert.equal(item.collapsibleState, 0);
});

test('a folder expands instead of opening a tab', async () => {
  const { SessionFilesProvider } = load();
  const item = new SessionFilesProvider(() => undefined).getTreeItem({ path: '/r/src', name: 'src', dir: true });
  assert.equal(item.collapsibleState, 1);
  assert.equal(item.command, undefined);
});

test('a folder that is gone or unreadable simply has no children', async () => {
  const { SessionFilesProvider } = load();
  const provider = new SessionFilesProvider(() => undefined);
  assert.deepEqual(list(await provider.getChildren({ path: '/no/such/folder', name: 'gone', dir: true })), []);
  assert.deepEqual(list(await provider.getChildren({ path: '/etc/hosts', name: 'hosts', dir: true })), []);
});

test('refresh tells VS Code the tree changed', async () => {
  const { SessionFilesProvider } = load();
  const provider = new SessionFilesProvider(() => undefined);
  let fired = 0;
  provider.onDidChangeTreeData(() => { fired += 1; });
  provider.refresh();
  assert.equal(fired, 1);
});
