// The PenguPool pi extension (pengupool/pi_extension.ts) as oh-my-pi runs it: omp hands
// before_agent_start a string[] system prompt, ends a run with agent_end (no agent_settled), has no
// --name flag and no session_info_changed. The extension is transpiled and run against a fake `pi`.
const test = require('node:test');
const { EventEmitter } = require('node:events');
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
  // a child's stdin; with opts.epipe the CLI has already exited, so writing to it fails with EPIPE
  const stdin = () => Object.assign(new EventEmitter(), {
    end() { if (opts.epipe) { this.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); } },
  });
  const childProcess = {
    execFile: (cmd, args, opts_, cb) => {
      calls.push(args);
      const out = args[1] === 'context' ? 'TREE CONTEXT' : '';
      if (args[1] === 'authorize' && opts.authorize === 3) {
        setImmediate(() => cb(Object.assign(new Error('refused'), { code: 3 }), '', 'not adjacent'));
        return { stdin: stdin() };
      }
      setImmediate(() => opts.epipe ? cb(Object.assign(new Error('exited'), { code: 1 }), '', '') : cb(null, out, ''));
      return { stdin: stdin() };
    },
  };
  const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const proc = Object.assign(Object.create(process), { env: { PENGUPOOL_HOME: home, ...env }, once() {} });
  const req = (id) => ({ 'node:child_process': childProcess, 'node:crypto': require('node:crypto'),
    'node:fs': fs, 'node:os': os, 'node:path': path })[id];
  // the name poll's timer, ticked by hand: tick() runs every interval callback once
  const timers = [];
  const setInterval = (fn) => { timers.push(fn); return { unref() {} }; };
  vm.runInNewContext(js, { module, exports: module.exports, require: req, process: proc, Date, JSON, Object,
    String, Promise, setImmediate, setInterval, Array });
  let name = '';
  const bindPi = () => {
    const handlers = {};
    module.exports.default({ on: (ev, fn) => { handlers[ev] = fn; }, getSessionName: () => name,
                             setSessionName: (n) => { name = n; } });
    return handlers;
  };
  const handlers = bindPi();
  // the session omp reports through ctx; a switch swaps it under the same process
  let sid = 'sid-1', file = '/s.jsonl';
  const ctx = { cwd: '/r', getContextUsage: () => ({ percent: 12 }),
    sessionManager: { getSessionId: () => sid, getSessionFile: () => file } };
  const livePath = path.join(home, 'pi-sessions', `${proc.pid}.json`);
  const live = () => JSON.parse(fs.readFileSync(livePath, 'utf8'));
  const switchTo = (next, nextFile = '/s.jsonl', nextName = '') => { sid = next; file = nextFile; name = nextName; };
  // omp calls the factory again, in the same process, for every subagent the session spawns
  const subagent = () => ({ handlers: bindPi(), ctx: { ...ctx, agent: { kind: 'sub', id: '0-Probe' },
    sessionManager: { getSessionId: () => 'sub-1', getSessionFile: () => '/sub.jsonl' } } });
  const rename = (n) => { name = n; };
  const tick = () => timers.forEach((fn) => fn());
  return { handlers, ctx, live, livePath, calls, proc, name: () => name, switchTo, subagent, home, rename, tick };
}

test('a new omp session takes its name from PENGUPOOL_SESSION_NAME, once', async () => {
  const x = load({ PENGUPOOL_SESSION_NAME: 'notes' });
  await x.handlers.session_start({ type: 'session_start' }, x.ctx);
  assert.equal(x.name(), 'notes');
  assert.equal(x.live().name, 'notes');
  assert.equal(x.proc.env.PENGUPOOL_SESSION_NAME, undefined);  // a later /new is not named "notes" too
});

test('a rename between turns reaches the live file without waiting for a run to end', async () => {
  const x = load({ PENGUPOOL_SESSION_NAME: 'notes' });
  await x.handlers.session_start({ type: 'session_start' }, x.ctx);
  x.rename('api');                                   // /rename, /alias or PenguPool's Rename: omp sends no event
  x.tick();
  assert.equal(x.live().name, 'api');
  await x.handlers.session_shutdown({ type: 'session_shutdown' }, x.ctx);
  x.rename('later');
  x.tick();
  assert.equal(fs.existsSync(x.livePath), false);    // a gone session's file is not written back
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
  // /resume (or /fork): the same process now hosts sid-2, another session
  x.switchTo('sid-2', '/t.jsonl');
  await x.handlers.session_switch({ type: 'session_switch', reason: 'resume', previousSessionFile: '/s.jsonl' }, x.ctx);
  assert.equal(x.live().sessionId, 'sid-2');        // not the session omp left behind
  assert.equal(x.live().sessionFile, '/t.jsonl');
  assert.equal(x.live().status, 'idle');
  assert.equal(x.live().name, '');                  // another session is not named "notes" too
  assert.equal(x.calls.some((a) => a[1] === 'carry'), false);   // nor does it take sid-1's place
  assert.deepEqual(registry().map((r) => r.sessionId), ['sid-1', 'sid-2']);
  assert.equal(x.calls.filter((a) => a[1] === 'register').length, 2);   // the new session gets a profile
  // its window is already in use: the map rings it now, not after the next turn
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.home, 'context', 'sid-2.json'), 'utf8')).pct, 12);
  // a branch that rewinds within the same session changes nothing
  await x.handlers.session_branch({ type: 'session_branch', reason: 'branch' }, x.ctx);
  assert.deepEqual(registry().map((r) => r.sessionId), ['sid-1', 'sid-2']);
});

test('/new is a fresh context: the new id takes over the name, group and role', async () => {
  const x = load({ PENGUPOOL_SESSION_NAME: 'notes' });
  await x.handlers.session_start({ type: 'session_start' }, x.ctx);
  x.switchTo('sid-2', '/t.jsonl');
  await x.handlers.session_switch({ type: 'session_switch', reason: 'new', previousSessionFile: '/s.jsonl' }, x.ctx);
  // ctl moves the seat once both ids are registered under this process's key
  assert.deepEqual(x.calls.map((a) => a.slice(0, 3).join(' ')),
                   ['ctl register sid-1', 'ctl register sid-2', 'ctl carry sid-1']);
  assert.deepEqual([...x.calls.at(-1)], ['ctl', 'carry', 'sid-1', 'sid-2']);
  assert.equal(x.live().sessionId, 'sid-2');
  assert.equal(x.live().name, 'notes');
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

test('a subagent never takes over or removes its session\'s pool entry', async () => {
  // omp runs the extension for a subagent in the session's own process. Binding it overwrote the live
  // file, registry line and env with the subagent's id, and its end deleted the file: until the next
  // prompt the session left the map and its children showed ungrouped.
  const x = load();
  const registry = () => fs.readFileSync(path.join(x.home, 'registry.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  await x.handlers.session_start({ type: 'session_start' }, x.ctx);
  await x.handlers.agent_start({}, x.ctx);
  const sub = x.subagent();
  for (const ev of ['session_start', 'agent_start', 'turn_end', 'agent_end']) { await sub.handlers[ev]({ type: ev }, sub.ctx); }
  await sub.handlers.tool_call({ toolName: 'intercom', input: { action: 'send', to: 'peer' } }, sub.ctx);
  await sub.handlers.session_shutdown({ type: 'session_shutdown' }, sub.ctx);
  assert.equal(x.live().sessionId, 'sid-1');
  assert.equal(x.live().status, 'busy');                     // the session still waits on its subagent
  assert.equal(x.proc.env.PENGUPOOL_SESSION, 'sid-1');       // the session's tools keep its id
  assert.deepEqual(registry().map((r) => r.sessionId), ['sid-1']);
  assert.equal(fs.existsSync(path.join(x.home, 'context', 'sub-1.json')), false);
  assert.deepEqual([...x.calls.at(-1)], ['ctl', 'authorize', 'sid-1', 'peer']);   // checked as the session's send
  await x.handlers.session_shutdown({ type: 'session_shutdown' }, x.ctx);
  assert.equal(fs.existsSync(x.livePath), false);           // the session's own end does remove it
});

test('a one-shot run is no pool session and sends as the session that started it', async () => {
  // `omp -p` registered as a live pool session. Started from a pool session's tool, it inherits that
  // session's id: it keeps it, registers nothing, and passes it to ctl, which checks the process tree.
  const x = load({ PENGUPOOL_SESSION: 'parent' });
  const ctx = { ...x.ctx, mode: 'print' };
  await x.handlers.session_start({ type: 'session_start' }, ctx);
  assert.equal(await x.handlers.before_agent_start({ prompt: 'go', systemPrompt: [] }, ctx), undefined);
  await x.handlers.agent_start({}, ctx);
  await x.handlers.tool_call({ toolName: 'intercom', input: { action: 'send', to: 'peer' } }, ctx);
  await x.handlers.agent_end({}, ctx);
  assert.equal(fs.existsSync(x.livePath), false);
  assert.equal(fs.existsSync(path.join(x.home, 'registry.jsonl')), false);
  assert.equal(x.proc.env.PENGUPOOL_SESSION, 'parent');
  assert.deepEqual(x.calls.map((a) => [...a]), [['ctl', 'authorize', 'parent', 'peer']]);
});

test('a one-shot run with no session in its env is still checked: ctl finds the sender', async () => {
  // `env -u PENGUPOOL_SESSION omp -p "intercom send …"` from a grouped session's shell skipped the guard
  const x = load({});
  const ctx = { ...x.ctx, mode: 'print' };
  await x.handlers.session_start({ type: 'session_start' }, ctx);
  await x.handlers.tool_call({ toolName: 'intercom', input: { action: 'send', to: 'far' } }, ctx);
  assert.deepEqual(x.calls.map((a) => [...a]), [['ctl', 'authorize', '', 'far']]);
});

test('contact_supervisor is checked against the session id and the target its env names', async () => {
  const x = load({ PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: 'boss-id', PI_SUBAGENT_ORCHESTRATOR_TARGET: 'boss' },
                 { authorize: 3 });
  await x.handlers.session_start({ type: 'session_start' }, x.ctx);
  const r = await x.handlers.tool_call({ toolName: 'contact_supervisor', input: { reason: 'need_decision' } }, x.ctx);
  assert.equal(r.block, true);
  assert.deepEqual([...x.calls.at(-1)], ['ctl', 'authorize', 'sid-1', 'boss-id']);
  const quiet = load({});   // no supervisor named: nothing to deliver to, nothing to check
  await quiet.handlers.tool_call({ toolName: 'contact_supervisor', input: {} }, quiet.ctx);
  assert.equal(quiet.calls.length, 0);
});

test('a CLI that exits before reading its input cannot crash the session', async () => {
  // writing to its closed stdin raises EPIPE; unhandled, it ended omp
  const x = load({}, { epipe: true });
  await x.handlers.session_start({ type: 'session_start' }, x.ctx);
  assert.equal(await x.handlers.before_agent_start({ prompt: 'hi', systemPrompt: [] }, x.ctx), undefined);
  assert.equal(x.live().sessionId, 'sid-1');
});
