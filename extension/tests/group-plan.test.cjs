const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the real watcher with only VS Code and the CLI replaced. `confirm` is what the modal returns,
// `pick` is what the notification's buttons return.
function harness(options = {}) {
  const context = [], notices = [], errors = [], ctl = [], warns = [];
  const vscode = {
    commands: { executeCommand: async (...args) => { context.push(args); } },
    window: {
      showInformationMessage: async (message, ...buttons) => { notices.push({ message, buttons }); return options.pick; },
      showWarningMessage: async (message, opts, ...buttons) => { warns.push({ message, opts, buttons }); return options.confirm; },
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
  return { exports, context, notices, errors, ctl, warns };
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
  assert.deepEqual(h.notices[0].buttons, ['Review', 'Discard']);
  assert.match(h.notices[0].message, /2 moves/);
  assert.match(h.notices[0].message, /Nothing moves until you approve it/);
  watcher.update(undefined);
  assert.deepEqual(h.context[1], ['setContext', 'pengupool.groupPlanPending', false]);
  watcher.update(null);
  assert.equal(h.context.length, 2); // already false: the key is not written again
});

test('Review shows every move, the reason and the routing cost, and applies on Apply', async () => {
  const h = harness({ confirm: 'Apply' });
  const watcher = new h.exports.GroupPlanWatcher();
  watcher.update(plan);
  await watcher.review();
  assert.equal(h.warns.length, 1);
  assert.match(h.warns[0].message, /Apply this regrouping\? 2 moves/);
  assert.equal(h.warns[0].opts.modal, true);
  assert.match(h.warns[0].opts.detail, /• kid under lead/);
  assert.match(h.warns[0].opts.detail, /• docs to top level/);
  assert.match(h.warns[0].opts.detail, /Why: same repo, one lead/);
  assert.match(h.warns[0].opts.detail, /who may message whom/);
  assert.deepEqual(h.ctl, [['group-apply']]);
  assert.match(h.notices.at(-1).message, /applied 2 move\(s\)/);
  assert.equal(h.errors.length, 0);
  assert.deepEqual(h.context.at(-1), ['setContext', 'pengupool.groupPlanPending', false]);
});

test('dismissing the modal moves nothing', async () => {
  const h = harness({});
  const watcher = new h.exports.GroupPlanWatcher();
  watcher.update(plan);
  await watcher.review();
  assert.equal(h.warns.length, 1);
  assert.deepEqual(h.ctl, []);
  assert.match(h.context.at(-1)[1], /groupPlanPending/);
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
  const h = harness({ confirm: 'Apply', result: { code: 2, stdout: '', stderr: 'the plan is stale; propose it again' } });
  const watcher = new h.exports.GroupPlanWatcher();
  watcher.update(plan);
  await watcher.review();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /the plan is stale/);
  assert.ok(!h.notices.some((n) => /applied/.test(n.message)));
});

test('the button is inert while nothing is waiting', async () => {
  const h = harness();
  const watcher = new h.exports.GroupPlanWatcher();
  await watcher.review();
  assert.match(h.notices[0].message, /no regrouping is waiting/);
  assert.deepEqual(h.ctl, []);
  assert.equal(h.warns.length, 0);
});

test('the manifest, the snapshot and the extension are wired for the proposal', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const command = manifest.contributes.commands.find((item) => item.command === 'pengupool.groupPlan');
  assert.ok(command, 'pengupool.groupPlan is not contributed');
  const menu = manifest.contributes.menus['view/title'].find((item) => item.command === 'pengupool.groupPlan');
  assert.ok(menu, 'the review button is not in the view/title menu');
  assert.match(menu.when, /pengupool\.groupPlanPending/);   // hidden until a session proposes one
  const serve = fs.readFileSync(path.join(__dirname, '../src/serveClient.ts'), 'utf8');
  assert.match(serve, /group_plan\?: GroupPlan \| null/);
  const extension = fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8');
  assert.match(extension, /groupPlan\.update\(snap\.group_plan\)/);
  assert.match(extension, /registerCommand\('pengupool\.groupPlan'/);
});
