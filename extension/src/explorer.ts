import * as vscode from 'vscode';

const SETTING = 'explorerFollow';
const ROOT_SETTING = 'explorerSessionRoot';
const ROOT_STATE_KEY = 'pengupool.explorerSessionRoot';   // what the earlier build recorded for a window
const ROOT_SETTLE_MS = 100;

/** Keeps the Explorer on the focused session's folder. Revealing a folder this window does not
 *  contain is only possible once the window stops being single-folder, and VS Code turns that into an
 *  unsaved ("UNTITLED (WORKSPACE)") multi-root workspace — so it is opt-in via `explorerSessionRoot`,
 *  it replaces one session root at a time, and the folder the window was opened on is never touched. */
export class ExplorerFollow {
  constructor(private readonly state: vscode.Memento) {}

  async follow(cwd: string): Promise<void> {
    if (!cwd || !this.setting(SETTING, true)) { return; }
    const uri = vscode.Uri.file(cwd);
    try {
      if (!vscode.workspace.getWorkspaceFolder(uri)) {
        if (!this.setting(ROOT_SETTING, false)) { return; }   // leave the window's workspace alone
        if (!(await this.addRoot(uri))) { return; }            // the window refused the folder
        // The new root reaches the Explorer asynchronously, and a reveal before that finds nothing.
        await new Promise((resolve) => setTimeout(resolve, ROOT_SETTLE_MS));
      }
      await vscode.commands.executeCommand('revealInExplorer', uri);
    } catch { /* the Explorer view is a convenience: a refused reveal must not interrupt the switch */ }
  }

  private setting(key: string, fallback: boolean): boolean {
    return vscode.workspace.getConfiguration('pengupool').get<boolean>(key, fallback);
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
