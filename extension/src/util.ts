import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { backendCommand, isRemote, remoteHost, sshArgs } from './remote';

export function claudePath(): string {
  return vscode.workspace.getConfiguration('pengupool').get<string>('command', 'pengupool');
}

export interface CtlResult { code: number; stdout: string; stderr: string; }

/** Run `<pengupool> ctl <args…>` one-shot. Resolves with exit code + output (never rejects, so callers
 *  can branch on code — e.g. `ctl attach` returns 2 when the session isn't on the tmux server).
 *
 *  With `pengupool.remoteHost` set, the same call runs on that host over ssh, so every caller (the tree,
 *  the panels, the session menus) becomes remote-aware through this one function. */
export function runCtl(args: string[]): Promise<CtlResult> {
  const remote = isRemote();
  const cmd = remote ? 'ssh' : claudePath();
  const argv = remote ? [...sshArgs(), remoteHost(), backendCommand(), 'ctl', ...args] : ['ctl', ...args];
  return new Promise((resolve) => {
    execFile(cmd, argv, { encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === 'number' ? (err as any).code : (err ? 1 : 0);
      resolve({ code, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}
