import * as vscode from 'vscode';
import { execFile } from 'child_process';

/**
 * Where the backend runs: this machine, or one host reached over ssh.
 *
 * `pengupool.remoteHost` names an ssh target, either an alias from `~/.ssh/config` or `user@host`. When
 * it is set, every backend call goes through ssh: `serve` streams over the connection, `ctl` runs one
 * remote command per call, and a session's terminal is an `ssh -t` into that host's tmux. The host needs
 * sshd, tmux and the pengupool CLI and nothing else (docs/remote-sessions-plan.md).
 *
 * One host, one connection. Which sessions appear is decided by that host's own `serve`, so this is a
 * window per host rather than a fleet view; the plan's per-env isolation is the next step.
 */
const INSTALLER = 'curl -fsSL https://pengupool.nduwork.com/install.sh | bash';

/** Where the installer puts the CLI. Non-interactive ssh does not read the shell rc, so `command -v`
 *  misses it; the probe looks here too. */
const FALLBACK = '$HOME/.local/bin/pengupool';

let resolved = '';

export function remoteHost(): string {
  return vscode.workspace.getConfiguration('pengupool').get<string>('remoteHost', '').trim();
}

export function isRemote(): boolean {
  return remoteHost() !== '';
}

/** The path the last probe found on the remote ('' before the first probe). */
export function resolvedCommand(): string {
  return resolved;
}

export function clearResolvedCommand(): void {
  resolved = '';
}

/** The `<command>` to invoke where the backend runs.
 *
 *  An explicit `pengupool.command` wins, since a user who typed a path meant it. Otherwise the probe's
 *  answer is used, which is what makes a fresh install work: the CLI lands in `~/.local/bin`, and no
 *  non-interactive ssh has that on PATH. */
export function backendCommand(): string {
  const configured = vscode.workspace.getConfiguration('pengupool').get<string>('command', 'pengupool').trim();
  if (configured && configured !== 'pengupool') {
    return configured;
  }
  return resolved || configured || 'pengupool';
}

/** ssh options every backend call shares. `interactive` is for a terminal, which may prompt for a
 *  passphrase; a background call must never wait on one, so it gets BatchMode.
 *
 *  ControlMaster puts the stream, the `ctl` calls and the terminals on one connection. Without it every
 *  `ctl` pays a handshake, and a click runs several. Skipped on Windows, where control sockets are
 *  unreliable. */
export function sshArgs(interactive = false): string[] {
  const args = [interactive ? '-t' : '-T'];
  if (!interactive) {
    args.push('-o', 'BatchMode=yes');
  }
  args.push('-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3');
  if (process.platform !== 'win32') {
    args.push('-o', 'ControlMaster=auto', '-o', 'ControlPath=~/.ssh/pengupool-cm-%r@%h:%p',
      '-o', 'ControlPersist=60s');
  }
  return args;
}

/** The remote shell command that answers where pengupool is, or nothing when it is not installed. */
export function probeCommand(): string {
  return `command -v pengupool || { [ -x "${FALLBACK}" ] && printf %s "${FALLBACK}"; }`;
}

/** Ask the remote where its CLI is and remember the answer. Resolves with '' when there is none. */
export function resolveRemoteCommand(): Promise<string> {
  return new Promise((resolve) => {
    if (!isRemote()) {
      resolve('');
      return;
    }
    execFile('ssh', [...sshArgs(), remoteHost(), probeCommand()], { encoding: 'utf8', timeout: 15_000 },
      (_err, stdout) => {
        const found = (stdout || '').trim().split('\n').pop()!.trim();
        if (found) {
          resolved = found;
        }
        resolve(found);
      });
  });
}

/** What a terminal runs on the remote to provision it: the published installer, which installs the CLI
 *  and wires every harness it finds. Interactive on purpose, because it asks before installing tmux or
 *  an agent CLI. */
export function installCommand(): string {
  return INSTALLER;
}
