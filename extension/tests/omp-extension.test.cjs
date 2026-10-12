// The PenguPool pi extension (pengupool/pi_extension.ts) as oh-my-pi runs it: omp hands
// before_agent_start a string[] system prompt, ends a run with agent_end (no agent_settled), has no
// --name flag and no session_info_changed. The extension is transpiled and run against a fake `pi`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SRC = path.join(__dirname, '../../pengupool/pi_extension.ts');

function load(env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-omp-'));
  const calls = [];
  const childProcess = {
    execFile: (cmd, args, opts, cb) => {
      calls.push(args);
      const out = args[1] === 'context' ? 'TREE CONTEXT' : '';
      setImmediate(() => cb(null, out, ''));
      return { stdin: { end() {} } };
    },
  };
  const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const proc = Object.assign(Object.create(process), { env: { PENGUPOOL_HOME: home, ...env }, once() {} });
  const req = (id) => ({ 'node:child_process': childProcess, 'node:crypto': require('node:crypto'),
    'node:fs': fs, 'node:os': os, 'node:path': path })[id];
  vm.runInNewContext(js, { module, exports: module.exports, require: req, process: proc, Date, JSON, Object,
    String, Promise, setImmediate, Array });
  const handlers = {};
  let name = '';
  const pi = { on: (ev, fn) => { handlers[ev] = fn; }, getSessionName: () => name,
               setSessionName: (n) => { name = n; } };
  module.exports.default(pi);
  const ctx = { cwd: '/r', getContextUsage: () => ({ percent: 12 }),
    sessionManager: { getSessionId: () => 'sid-1', getSessionFile: () => '/s.jsonl' } };
  const live = () => JSON.parse(fs.readFileSync(path.join(home, 'pi-sessions', `${proc.pid}.json`), 'utf8'));
  return { handlers, ctx, live, calls, proc, name: () => name };
}

test('a new omp session takes its name from PENGUPOOL_SESSION_NAME, once', async () => {
  const x = load({ PENGUPOOL_SESSION_NAME: 'notes' });
  await x.handlers.session_start({ type: 'session_start' }, x.ctx);
  assert.equal(x.name(), 'notes');
  assert.equal(x.live().name, 'notes');
  assert.equal(x.proc.env.PENGUPOOL_SESSION_NAME, undefined);  // a later /new is not named "notes" too
});

test('the tree context is appended to an omp string[] system prompt', async () => {
  const x = load();
  await x.handlers.session_start({ type: 'session_start' }, x.ctx);
  const r = await x.handlers.before_agent_start({ prompt: 'hi', systemPrompt: ['base', 'tools'] }, x.ctx);
  assert.deepEqual([...r.systemPrompt], ['base', 'tools', 'TREE CONTEXT']);
  const s = await x.handlers.before_agent_start({ prompt: 'hi', systemPrompt: 'base' }, x.ctx);
  assert.equal(s.systemPrompt, 'base\n\nTREE CONTEXT');   // plain pi's string prompt still works
});

test('agent_end settles the session unless omp continues the run', async () => {
  const x = load();
  await x.handlers.session_start({ type: 'session_start' }, x.ctx);
  await x.handlers.agent_start({}, x.ctx);
  await x.handlers.agent_end({ willContinue: true }, x.ctx);
  assert.equal(x.live().status, 'busy');
  await x.handlers.agent_end({ willContinue: false }, x.ctx);
  assert.equal(x.live().status, 'idle');
});
