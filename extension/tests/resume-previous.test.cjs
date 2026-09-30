const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const now = Date.now();
const SESSIONS = [
  ['pi-1', 'pengutool', 'pi', '/repos/pengutool', now - 4_000],
  ['pi-2', 'oh-tidepool', 'pi', '/repos/oh-tidepool', now - 3 * 3_600_000],
];

/** The real command registry with VS Code replaced: quick picks answer themselves, runCtl is scripted. */
function harness(options = {}) {
  const handlers = {}, ctl = [], picks = [], messages = [], bound = [];
  const listed = options.list ?? { code: 0, stdout: JSON.stringify(SESSIONS) };
  const vscode = {
    Uri: { file: (fsPath) => ({ fsPath }) },
    ProgressLocation: { Notification: 15 },
    commands: {
      registerCommand: (id, fn) => { handlers[id] = fn; return { dispose() {} }; },
      executeCommand: async () => {},
    },
    window: {
      showErrorMessage: (message) => messages.push(['error', message]),
      showInformationMessage: async (message) => { messages.push(['info', message]); return undefined; },
      showWarningMessage: async (message) => { messages.push(['warn', message]); return undefined; },
      showQuickPick: async (items, opts) => {
        picks.push([items, opts]);
        return options.answer === undefined ? items.filter((item) => item.picked) : options.answer;
      },
      withProgress: async (_options, task) => task({ report() {} }),
    },
  };
  const runCtl = async (args) => {
    ctl.push(args);
    if (args[0] === 'past-all') { return listed; }
    return options.resume?.(args) ?? { code: 0, stdout: '', stderr: '' };
  };
  const outputs = {};
  const filename = path.join(__dirname, '../src/commands.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  vm.runInNewContext(code, {
    exports: outputs, process,
    require: (id) => {
      if (id === 'vscode') { return vscode; }
      if (id === './util') { return { runCtl }; }
      if (id === './mapPanel') { return { MapPanel: { showIfOpen: () => undefined } }; }
      if (id === './logPanel') { return { LogPanel: { showIfOpen: () => undefined } }; }
      return {};
    },
  }, { filename });
  outputs.registerCommands({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } }, {
    provider: { find: () => undefined },
    terminals: { resume: async (cwd, name, id, harness_) => { bound.push([cwd, name, id, harness_]); } },
    tree: { selection: [], reveal: async () => {} },
    explorer: { follow: async () => {} },
  });
  const restore = () => handlers['pengupool.resumePrevious']();
  return { restore, ages: outputs.ago, ctl, picks, messages, bound,
    resumed: () => ctl.filter((args) => args[0] === 'resume') };
}

test('the run-all button restores every past session, newest first, and looks at the first', async () => {
  const h = harness();
  await h.restore();
  const [items, options] = h.picks[0];
  assert.equal(options.canPickMany, true);
  assert.deepEqual([...items.map((item) => item.label)], ['pengutool', 'oh-tidepool']);
  assert.deepEqual([...items.map((item) => item.picked)], [true, true]);
  assert.match(items[0].description, /^pi · \/repos\/pengutool · just now$/);
  assert.match(items[1].description, /3 h ago$/);
  assert.deepEqual(h.resumed().map((args) => [...args]),
                   [['resume', '/repos/pengutool', 'pengutool', 'pi-1'],
                    ['resume', '/repos/oh-tidepool', 'oh-tidepool', 'pi-2']]);
  assert.deepEqual(h.bound, [['/repos/pengutool', 'pengutool', 'pi-1', 'pi']]);
  assert.deepEqual(h.messages, [['info', 'PenguPool: resumed 2 sessions.']]);
});

test('unticking everything restores nothing and leaves the terminal alone', async () => {
  const h = harness({ answer: [] });
  await h.restore();
  assert.deepEqual(h.resumed(), []);
  assert.deepEqual(h.bound, []);
  assert.deepEqual(h.messages, []);
});

test('nothing to restore says so instead of opening an empty list', async () => {
  const h = harness({ list: { code: 0, stdout: '[]' } });
  await h.restore();
  assert.deepEqual(h.picks, []);
  assert.deepEqual(h.messages, [['info', 'PenguPool: no previous sessions to resume.']]);
});

test('a session that will not come back is counted, not hidden', async () => {
  const h = harness({ resume: (args) => (args[3] === 'pi-2' ? { code: 1, stderr: 'window gone' } : { code: 0 }) });
  await h.restore();
  assert.deepEqual(h.bound, [['/repos/pengutool', 'pengutool', 'pi-1', 'pi']]);
  assert.deepEqual(h.messages, [['warn', 'PenguPool: resumed 1 of 2 — oh-tidepool: window gone']]);
});

test('a failing list is surfaced instead of looking like an empty pool', async () => {
  const h = harness({ list: { code: 1, stderr: 'no backend' } });
  await h.restore();
  assert.deepEqual(h.picks, []);
  assert.deepEqual(h.messages, [['error', 'PenguPool: no backend']]);
});

test('restore ages read as a timeline, not a timestamp', () => {
  const h = harness();
  assert.equal(h.ages(Date.now()), 'just now');
  assert.equal(h.ages(Date.now() - 3 * 60_000), '3 min ago');
  assert.equal(h.ages(Date.now() - 5 * 3_600_000), '5 h ago');
  assert.equal(h.ages(Date.now() - 3 * 86_400_000), '3 d ago');
});
