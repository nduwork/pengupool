const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const ts = require('typescript');

/**
 * The ssh endpoint: with `pengupool.remoteHost` set, the stream, every `ctl` call and every session
 * terminal go through ssh to that host, and the CLI's location there is asked for rather than assumed.
 *
 * Real modules, fake VS Code and fake subprocesses. `reply` decides what a `ctl` call returns, so a test
 * can exercise the terminal path without a remote.
 */
function harness(settings = {}, { reply = () => '' } = {}) {
  const config = { command: 'pengupool', remoteHost: '', ...settings };
  const spawned = [], executed = [], created = [], notifications = [], cache = new Map();
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }) },
    window: {
      terminals: [],
      activeTerminal: undefined,
      onDidOpenTerminal: () => ({ dispose() {} }),
      onDidChangeActiveTerminal: () => ({ dispose() {} }),
      onDidCloseTerminal: () => ({ dispose() {} }),
      createTerminal: (options) => {
        created.push(options);
        return { name: options.name, exitStatus: undefined, show() {}, sendText() {}, dispose() {} };
      },
      showErrorMessage: async (message, ...items) => { notifications.push({ message, items }); return undefined; },
      showInformationMessage: async (message) => { notifications.push({ message }); return undefined; },
      showWarningMessage: async () => undefined,
      showQuickPick: async () => undefined,
    },
    commands: { executeCommand: async () => undefined },
    env: { openExternal: () => undefined },
    Uri: { parse: (s) => s, file: (s) => s },
    ProgressLocation: { Notification: 15 },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  };
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    spawned.push({ cmd, args });
    return child;
  };
  const execFile = (cmd, args, _options, callback) => {
    executed.push({ cmd, args });
    callback(null, reply(args), '');
  };
  function load(name) {
    if (cache.has(name)) {
      return cache.get(name);
    }
    const exports = {};
    cache.set(name, exports);   // before running, so a cycle resolves to the same instance
    const code = ts.transpileModule(
      fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } },
    ).outputText;
    vm.runInNewContext(code, {
      exports,
      process,
      console,
      setTimeout,
      clearTimeout,
      require: (id) => {
        if (id === 'vscode') { return vscode; }
        if (id === 'child_process') { return { spawn, execFile }; }
        if (id.startsWith('./')) { return load(id.slice(2)); }
        throw new Error('Unexpected dependency: ' + id);
      },
    }, { filename: name + '.ts' });
    return exports;
  }
  return { config, spawned, executed, created, notifications, load };
}

const node = { id: 'sid', name: 'worker', cwd: '/remote/repo', tmux_pane: '%9', harness: 'cc', children: [] };

test('a local workspace is untouched: the CLI runs here, not over ssh', () => {
  const h = harness();
  const remote = h.load('remote');
  assert.equal(remote.isRemote(), false);
  const { runCtl } = h.load('util');
  return runCtl(['tree']).then(() => {
    assert.equal(h.executed.length, 1);
    assert.equal(h.executed[0].cmd, 'pengupool');
    assert.deepEqual([...h.executed[0].args], ['ctl', 'tree']);
  });
});

test('with a remote host every ctl call runs there over ssh', () => {
  const h = harness({ remoteHost: 'buildbox' });
  const { runCtl } = h.load('util');
  return runCtl(['--json', 'attach', 'sid', 'worker']).then(() => {
    const [call] = h.executed;
    assert.equal(call.cmd, 'ssh');
    assert.equal(call.args.at(-7), 'buildbox');
    assert.deepEqual([...call.args].slice(-6), ['pengupool', 'ctl', '--json', 'attach', 'sid', 'worker']);
    assert.ok(call.args.includes('BatchMode=yes'), 'a background call must never wait on a password');
    assert.ok(call.args.includes('-T'), 'no pty for a one-shot call');
    assert.ok(call.args.some((a) => a.startsWith('ControlPath=')), 'one connection shared by every call');
  });
});

test('the probe finds the CLI the installer put outside PATH, and an explicit path still wins', async () => {
  const h = harness({ remoteHost: 'buildbox' }, { reply: () => '/home/sandbox/.local/bin/pengupool\n' });
  const remote = h.load('remote');
  assert.equal(remote.backendCommand(), 'pengupool', 'before the probe, the configured default');
  await remote.resolveRemoteCommand();
  assert.equal(remote.resolvedCommand(), '/home/sandbox/.local/bin/pengupool');
  assert.equal(remote.backendCommand(), '/home/sandbox/.local/bin/pengupool');
  assert.match(h.executed.at(-1).args.at(-1), /command -v pengupool/);

  const explicit = harness({ remoteHost: 'buildbox', command: '/opt/pengupool' });
  const pinned = explicit.load('remote');
  await pinned.resolveRemoteCommand();
  assert.equal(pinned.backendCommand(), '/opt/pengupool', 'a typed path beats the probe');
});

test('the snapshot stream is ssh, and the CLI it runs is the one the probe found', async () => {
  const h = harness({ remoteHost: 'buildbox' }, { reply: () => '/home/sandbox/.local/bin/pengupool\n' });
  const remote = h.load('remote');
  await remote.resolveRemoteCommand();
  const { ServeClient } = h.load('serveClient');
  new ServeClient({ append() {}, appendLine() {} }).start();
  const [call] = h.spawned;
  assert.equal(call.cmd, 'ssh');
  assert.deepEqual([...call.args].slice(-3), ['buildbox', '/home/sandbox/.local/bin/pengupool', 'serve']);
});

test('a remote session terminal is an interactive ssh that may prompt, and sends no local cwd', async () => {
  const h = harness({ remoteHost: 'buildbox' }, {
    reply: () => JSON.stringify({ command: 'tmux -L pengupool new-session -A -s view', pane: '%9', cwd: '/remote/repo' }),
  });
  const { TerminalManager } = h.load('terminals');
  const manager = new TerminalManager({ workspaceState: { get: () => ({}), update: async () => {} } });
  assert.equal(await manager.switchTo(node), true);
  const [terminal] = h.created;
  assert.equal(terminal.shellPath, 'ssh');
  assert.deepEqual([...terminal.shellArgs].slice(-2), ['buildbox', 'exec tmux -L pengupool new-session -A -s view']);
  assert.ok(terminal.shellArgs.includes('-t'), 'a terminal may prompt for a passphrase');
  assert.ok(!terminal.shellArgs.includes('BatchMode=yes'));
  assert.equal(terminal.cwd, undefined, 'a remote path means nothing to the local terminal');
});

test('installing on the host uses the published installer, interactively', () => {
  const h = harness({ remoteHost: 'buildbox' });
  const remote = h.load('remote');
  assert.match(remote.installCommand(), /install\.sh/);
  const args = remote.sshArgs(true);
  assert.equal(args[0], '-t');
  assert.ok(!args.includes('BatchMode=yes'), 'the installer asks questions, so ssh must not forbid a prompt');
});
