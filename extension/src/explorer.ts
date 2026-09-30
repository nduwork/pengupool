import * as vscode from 'vscode';

const SETTING = 'sessionFolder';
const ROOT_STATE_KEY = 'pengupool.explorerSessionRoot';   // what an earlier build recorded for a window
const ROOT_SETTLE_MS = 100;

/** What selecting a session does to the Explorer, from `pengupool.sessionFolder`. VS Code shows a
 *  folder in the Explorer only when the window contains it, so a folder the window does not contain
 *  has exactly two ways in: make it the window's own folder (in place, and the window reloads onto it)
 *  or add it as one extra workspace folder (which turns the window into an unsaved multi-folder one). */
export type SessionFolderMode = 'reveal' | 'window' | 'roots' | 'off';

export class ExplorerFollow {
  constructor(private readonly state: vscode.Memento) {}

  async follow(cwd: string): Promise<void> {
    const mode = this.mode();
    if (!cwd || mode === 'off') { return; }
    const uri = vscode.Uri.file(cwd);
    try {
      if (!vscode.workspace.getWorkspaceFolder(uri)) {
        if (mode === 'reveal') { return; }                     // leave the window's workspace alone
        if (mode === 'window') {
          // Replaces this window's folder: the Explorer lands on the session in place.
          await vscode.commands.executeCommand('vscode.openFolder', uri, { forceReuseWindow: true });
          return;
        }
        if (!(await this.addRoot(uri))) { return; }             // the window refused the folder
        // The new root reaches the Explorer asynchronously, and a reveal before that finds nothing.
        await new Promise((resolve) => setTimeout(resolve, ROOT_SETTLE_MS));
      }
      await vscode.commands.executeCommand('revealInExplorer', uri);
    } catch { /* the Explorer view is a convenience: a refused reveal must not interrupt the switch */ }
  }

  private mode(): SessionFolderMode {
    const value = vscode.workspace.getConfiguration('pengupool').get<string>(SETTING, 'reveal');
    return value === 'window' || value === 'roots' || value === 'off' ? value : 'reveal';
  }

  /** Replaces the session root added last time, or appends this folder when there is none to replace. */
  private async addRoot(uri: vscode.Uri): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const previous = this.state.get<string>(ROOT_STATE_KEY);
    const index = previous ? folders.findIndex((folder) => folder.uri.toString() === previous) : -1;
    const at = index >= 0 ? index : folders.length;
    const accepted = await vscode.workspace.updateWorkspaceFolders(at, index >= 0 ? 1 : 0, { uri });
    if (accepted) { await this.state.update(ROOT_STATE_KEY, uri.toString()); }
    return accepted;
  }
}
