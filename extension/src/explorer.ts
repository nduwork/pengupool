import * as vscode from 'vscode';

const SETTING = 'explorerFollow';

/** Keeps the Explorer on the focused session's folder, when this window already contains it. VS Code
 *  lists only workspace folders, and it has no API to replace a window's own folder, so a folder the
 *  window does not contain is left alone: this never adds a folder, never reloads, never opens a
 *  window. `pengupool.explorerFollow: false` turns the reveal off. */
export class ExplorerFollow {
  async follow(cwd: string): Promise<void> {
    if (!cwd || !vscode.workspace.getConfiguration('pengupool').get<boolean>(SETTING, true)) { return; }
    const uri = vscode.Uri.file(cwd);
    if (!vscode.workspace.getWorkspaceFolder(uri)) { return; }
    try {
      await vscode.commands.executeCommand('revealInExplorer', uri);
    } catch { /* the Explorer view is a convenience: a refused reveal must not interrupt the switch */ }
  }
}
