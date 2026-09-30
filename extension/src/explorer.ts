import * as vscode from 'vscode';

const SETTING = 'explorerFollow';
const ROOT_KEY = 'pengupool.explorerSessionRoot';
const ROOT_SETTLE_MS = 100;

/** Keeps the Explorer on the focused session's folder. VS Code can only reveal a folder the window
 *  already contains, so a folder outside every root is added as one extra workspace folder: the next
 *  switch replaces that session root in place, and folders the user added stay where they are. */
export class ExplorerFollow {
  constructor(private readonly state: vscode.Memento) {}

  async follow(cwd: string): Promise<void> {
    if (!cwd || !vscode.workspace.getConfiguration('pengupool').get<boolean>(SETTING, true)) { return; }
    const uri = vscode.Uri.file(cwd);
    try {
      if (!vscode.workspace.getWorkspaceFolder(uri)) {
        if (!(await this.addRoot(uri))) { return; }   // the window refused the folder: nothing to reveal
        // The new root reaches the Explorer asynchronously, and a reveal before that finds nothing.
        await new Promise((resolve) => setTimeout(resolve, ROOT_SETTLE_MS));
      }
      await vscode.commands.executeCommand('revealInExplorer', uri);
    } catch { /* the Explorer view is a convenience: a refused reveal must not interrupt the switch */ }
  }

  /** Replaces the session root added last time, or appends this folder when there is none to replace. */
  private async addRoot(uri: vscode.Uri): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const previous = this.state.get<string>(ROOT_KEY);
    const index = previous ? folders.findIndex((folder) => folder.uri.toString() === previous) : -1;
    const at = index >= 0 ? index : folders.length;
    const accepted = await vscode.workspace.updateWorkspaceFolders(at, index >= 0 ? 1 : 0, { uri });
    if (accepted) { await this.state.update(ROOT_KEY, uri.toString()); }
    return accepted;
  }
}
