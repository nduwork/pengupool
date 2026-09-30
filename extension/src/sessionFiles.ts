import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SessionNode } from './serveClient';

const SKIP = new Set(['.git', '.DS_Store']);
const MAX_ENTRIES = 500;

/** One entry in a session's folder. Ids are the paths, so the tree keeps its expansion across refreshes. */
export interface FileNode { path: string; name: string; dir: boolean; }

async function readdir(dir: string): Promise<FileNode[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => !SKIP.has(entry.name))
      .map((entry) => ({ path: path.join(dir, entry.name), name: entry.name, dir: entry.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];   // a folder that is gone, unreadable or not a folder simply has no children
  }
}

/** A read-only tree of the selected session's folder, so its files are reachable in place: clicking one
 *  opens it in an editor the way a terminal path link does, and nothing is added to the window's
 *  workspace — VS Code can only list workspace folders in its own Explorer. */
export class SessionFilesProvider implements vscode.TreeDataProvider<FileNode>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<FileNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly selection: () => SessionNode | undefined) {}

  /** The pool's selection or its sessions changed. */
  refresh(): void { this._onDidChange.fire(undefined); }

  getChildren(node?: FileNode): FileNode[] | Promise<FileNode[]> {
    if (node) { return node.dir ? readdir(node.path) : []; }
    const selected = this.selection();
    const cwd = selected?.cwd ?? '';
    return cwd ? [{ path: cwd, name: path.basename(cwd) || cwd, dir: true }] : [];
  }

  getTreeItem(node: FileNode): vscode.TreeItem {
    const uri = vscode.Uri.file(node.path);
    const item = new vscode.TreeItem(uri, node.dir
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None);
    item.id = node.path;
    item.tooltip = node.path;
    if (!node.dir) {
      // The same open-a-path-an-editor-tab action a terminal file link uses, for a file inside or
      // outside this window's workspace. A folder needs no command: VS Code expands it.
      item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
    }
    return item;
  }

  dispose(): void { this._onDidChange.dispose(); }
}
