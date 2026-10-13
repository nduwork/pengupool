// skills/workflow-tracker/pi/workflow-tracker.ts as oh-my-pi runs it: once per session, and again for
// every subagent in the same process. Only the session itself keys the tracker and gets the nudge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SRC = path.join(__dirname, '../../skills/workflow-tracker/pi/workflow-tracker.ts');

function load() {
  const calls = [];
  const childProcess = { execFile: (cmd, args, opts, cb) => {
    calls.push(args);
    setImmediate(() => cb(null, 'CHAIN LINE', ''));
    return { stdin: { end() {} } };
  } };
  const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const proc = { env: { STEP_STATUS_BIN: '/bin/tracker' } };
  vm.runInNewContext(js, { module, exports: module.exports, process: proc, JSON, String, Promise, setImmediate, Array,
    require: (id) => ({ 'node:child_process': childProcess, 'node:path': path })[id] });
  const handlers = {};
  module.exports.default({ on: (ev, fn) => { handlers[ev] = fn; } });
  const ctx = (sid, extra = {}) => ({ cwd: '/r', sessionManager: { getSessionId: () => sid }, ...extra });
  return { calls, handlers, proc, ctx };
}

test('the session keys the tracker and gets its chain line', async () => {
  const x = load();
  await x.handlers.session_start({}, x.ctx('main'));
  const r = await x.handlers.before_agent_start({ systemPrompt: ['base'] }, x.ctx('main'));
  assert.equal(x.proc.env.STEP_STATUS_SESSION, 'main');
  assert.equal(JSON.stringify(r.systemPrompt), '["base","CHAIN LINE"]');
});

test('a subagent or a one-shot run neither rekeys the tracker nor gets the nudge', async () => {
  const x = load();
  await x.handlers.session_start({}, x.ctx('main'));
  for (const extra of [{ agent: { kind: 'sub' } }, { mode: 'print' }, { mode: 'json' }]) {
    await x.handlers.session_start({}, x.ctx('other', extra));
    assert.equal(await x.handlers.before_agent_start({ systemPrompt: ['base'] }, x.ctx('other', extra)), undefined);
  }
  assert.equal(x.proc.env.STEP_STATUS_SESSION, 'main');
  assert.equal(x.calls.length, 0);
});
