const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the real watcher with only VS Code and the CLI replaced.
function harness(options = {}) {
  const context = [], notices = [], errors = [], ctl = [];
  const vscode = {
    commands: { executeCommand: async (...args) => { context.push(args); } },
    window: {
      showInformationMessage: async (message, ...buttons) => { notices.push({ message, buttons }); },
      showErrorMessage: (message) => errors.push(message),
    },
  };
  const filename = path.join(__dirname, '../src/groupPlan.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, process, console,
    require: (id) => id === 'vscode' ? vscode : id === './util' ? {
      runCtl: async (args) => {
        ctl.push([...args]);                      // a host-realm copy: deepEqual compares prototypes
        return options.result ?? { code: 0, stdout: 'applied 2 move(s)', stderr: '' };
      },
    } : {},
  }, { filename });
  return { exports, context, notices, errors, ctl };
}

const plan = {
  created: 1732.5,
  note: 'same repo, one lead',
  moves: [{ child: 'a', parent: 'b', label: 'kid under lead' },
          { child: 'c', parent: '', label: 'docs to top level' }],
};

test('a waiting proposal shows the button and is announced exactly once', () => {
  const h = harness();
  const watcher = new h.exports.GroupPlanWatcher();
  watcher.update(plan);
  watcher.update(plan);              // the same plan every snapshot tick: one announcement, not sixty
  assert.deepEqual(h.context, [['setContext', 'pengupool.groupPlanPending', true]]);
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.notices[0].buttons, ['Apply', 'Discard']);
  assert.match(h.notices[0].message, /2 moves/);
  assert.match(h.notices[0].message, /kid under lead/);
  assert.match(h.notices[0].message, /docs to top level/);
  assert.match(h.notices[0].message, /Why: same repo, one lead/);
  watcher.update(undefined);
  assert.deepEqual(h.context[1], ['setContext', 'pengupool.groupPlanPending', false]);
  watcher.update(null);
  assert.equal(h.context.length, 2); // already false: the key is not written again
});

test('Apply runs the regrouping directly; the notification carries the moves', async () => {
  const h = harness();
  const watcher = new h.exports.GroupPlanWatcher();
  watcher.update(plan);
  // The notification lists every move so a single click is enough to approve.
  assert.match(h.notices[0].message, /kid under lead/);
  assert.match(h.notices[0].message, /docs to top level/);
  assert.match(h.notices[0].message, /Why: same repo, one lead/);
  await watcher.apply();
  assert.deepEqual(h.ctl, [['group-apply']]);
  assert.match(h.notices.at(-1).message, /applied 2 move\(s\)/);
  assert.equal(h.errors.length, 0);
  assert.deepEqual(h.context.at(-1), ['setContext', 'pengupool.groupPlanPending', false]);
});

test('Discard drops the proposal without applying it', async () => {
  const h = harness({ result: { code: 0, stdout: 'discarded 2 proposed move(s)', stderr: '' } });
  const watcher = new h.exports.GroupPlanWatcher();
  watcher.update(plan);
  await watcher.discard();
  assert.deepEqual(h.ctl, [['group-apply', '--discard']]);
  assert.match(h.notices.at(-1).message, /discarded 2/);
  assert.equal(h.errors.length, 0);
});

test('a refused apply is reported, never announced as done', async () => {
  const h = harness({ result: { code: 2, stdout: '', stderr: 'The plan is stale, so propose it again' } });
  const watcher = new h.exports.GroupPlanWatcher();
  watcher.update(plan);
  await watcher.apply();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /The plan is stale/);
  assert.ok(!h.notices.some((n) => /applied/.test(n.message)));
});

test('the button is inert while nothing is waiting', async () => {
  const h = harness();
  const watcher = new h.exports.GroupPlanWatcher();
  await watcher.apply();
  assert.match(h.notices[0].message, /no regrouping is waiting/);
  assert.deepEqual(h.ctl, []);
});

test('the manifest, the snapshot and the extension are wired for the proposal', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const command = manifest.contributes.commands.find((item) => item.command === 'pengupool.groupPlan');
  assert.ok(command, 'pengupool.groupPlan is not contributed');
  // The apply button lives on the map's editor title bar, not the Sessions view's.
  const menu = manifest.contributes.menus['webview/editor/title'].find((item) => item.command === 'pengupool.groupPlan');
  assert.ok(menu, 'the apply button is not in the webview/editor/title menu');
  assert.match(menu.when, /webview == pengupoolMap/);
  assert.match(menu.when, /pengupool\.groupPlanPending/);   // hidden until a session proposes one
  const serve = fs.readFileSync(path.join(__dirname, '../src/serveClient.ts'), 'utf8');
  assert.match(serve, /group_plan\?: GroupPlan \| null/);
  const extension = fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8');
  assert.match(extension, /groupPlan\.update\(snap\.group_plan\)/);
  assert.match(extension, /registerCommand\('pengupool\.groupPlan'/);
});
