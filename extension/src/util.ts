import * as vscode from 'vscode';
import { execFile } from 'child_process';

/** The OS file manager, named the way VS Code names it: Finder on macOS, the containing folder elsewhere. */
export const REVEAL_LABEL =
  typeof process !== 'undefined' && process.platform !== 'darwin' ? 'Open Containing Folder' : 'Reveal in Finder';

export function claudePath(): string {
  return vscode.workspace.getConfiguration('pengupool').get<string>('command', 'pengupool');
}

export interface CtlResult { code: number; stdout: string; stderr: string; }

/** Run `pengupool ctl <args…>` one-shot. Resolves with exit code + output (never rejects, so callers
 *  can branch on code — e.g. `ctl attach` returns 2 when the session isn't on the tmux server). */
export function runCtl(args: string[]): Promise<CtlResult> {
  return new Promise((resolve) => {
    execFile(claudePath(), ['ctl', ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === 'number' ? (err as any).code : (err ? 1 : 0);
      resolve({ code, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}
