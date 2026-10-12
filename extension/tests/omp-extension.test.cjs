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

function load(env = {}, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-omp-'));
  const calls = [];
  const childProcess = {
    execFile: (cmd, args, opts_, cb) => {
      calls.push(args);
      const out = args[1] === 'context' ? 'TREE CONTEXT' : '';
      if (args[1] === 'authorize' && opts.authorize === 3) {
        setImmediate(() => cb(Object.assign(new Error('refused'), { code: 3 }), '', 'not adjacent'));
        return { stdin: { end() {} } };
      }
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
  // the session omp reports through ctx; a switch swaps it under the same process
  let sid = 'sid-1', file = '/s.jsonl';
  const ctx = { cwd: '/r', getContextUsage: () => ({ percent: 12 }),
    sessionManager: { getSessionId: () => sid, getSessionFile: () => file } };
  const live = () => JSON.parse(fs.readFileSync(path.join(home, 'pi-sessions', `${proc.pid}.json`), 'utf8'));
  const switchTo = (next, nextFile = '/s.jsonl', nextName = '') => { sid = next; file = nextFile; name = nextName; };
  return { handlers, ctx, live, calls, proc, name: () => name, switchTo, home };
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

test('a session omp swaps under a live process is rebound, hooks and all', async () => {
  const x = load({ PENGUPOOL_SESSION_NAME: 'notes' });
  const registry = () => fs.readFileSync(path.join(x.home, 'registry.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  await x.handlers.session_start({ type: 'session_start' }, x.ctx);
  assert.equal(x.live().sessionId, 'sid-1');
  assert.deepEqual(registry().map((r) => r.sessionId), ['sid-1']);
  // /new (or /resume, /fork): the same process now hosts sid-2
  x.switchTo('sid-2', '/t.jsonl');
  await x.handlers.session_switch({ type: 'session_switch', reason: 'new', previousSessionFile: '/s.jsonl' }, x.ctx);
  assert.equal(x.live().sessionId, 'sid-2');        // not the session omp left behind
  assert.equal(x.live().sessionFile, '/t.jsonl');
  assert.equal(x.live().status, 'idle');
  assert.equal(x.live().name, '');                  // a later session is not named "notes" too
  assert.deepEqual(registry().map((r) => r.sessionId), ['sid-1', 'sid-2']);
  assert.equal(x.calls.filter((a) => a[1] === 'register').length, 2);   // the new session gets a profile
  // a branch that rewinds within the same session changes nothing
  await x.handlers.session_branch({ type: 'session_branch', reason: 'branch' }, x.ctx);
  assert.deepEqual(registry().map((r) => r.sessionId), ['sid-1', 'sid-2']);
});

test('a compaction refreshes the context the map rings, mid-turn', async () => {
  const x = load();
  await x.handlers.session_start({ type: 'session_start' }, x.ctx);
  await x.handlers.session_compact({ type: 'session_compact' }, x.ctx);
  const got = JSON.parse(fs.readFileSync(path.join(x.home, 'context', 'sid-1.json'), 'utf8'));
  assert.equal(got.pct, 12);
});

test('a handover to a session out of reach is blocked like send and ask', async () => {
  const x = load({}, { authorize: 3 });
  await x.handlers.session_start({ type: 'session_start' }, x.ctx);
  for (const action of ['send', 'ask', 'handover']) {
    const r = await x.handlers.tool_call({ toolName: 'intercom', input: { action, to: 'far' } }, x.ctx);
    assert.deepEqual({ ...r }, { block: true, reason: 'not adjacent' }, action);
    assert.deepEqual([...x.calls.at(-1)], ['ctl', 'authorize', 'sid-1', 'far'], action);  // the caller omp reports
  }
  const before = x.calls.length;
  assert.equal(await x.handlers.tool_call({ toolName: 'intercom', input: { action: 'list' } }, x.ctx), undefined);
  assert.equal(x.calls.length, before);   // listing peers reaches no session: no authorize, no block
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
