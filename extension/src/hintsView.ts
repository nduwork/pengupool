import * as vscode from 'vscode';

/** Static help pinned below the Sessions tree — the controls cheat sheet. */
type Hint = {
  label: string;
  description?: string;
  icon?: string;
  tooltip?: string;
  command?: string;          // clicking the row runs it (title-bar buttons only)
  children?: Hint[];
};

const SESSIONS = 'Sessions view focused';

const HINTS: Hint[] = [
  { label: 'Keys', description: SESSIONS, icon: 'keyboard', children: [
    { label: '⏎', description: 'open · focus work session', icon: 'go-to-file' },
    { label: 'n', description: 'folder or new worktree · Claude Code or pi', icon: 'add' },
    { label: 'a', description: 'add previous Claude Code or pi session', icon: 'history' },
    { label: 'g', description: 'group under session · empty = top level', icon: 'list-tree' },
    { label: 'r', description: 'rename session', icon: 'edit' },
    { label: 'd', description: 'describe role', icon: 'note' },
    { label: 'x', description: 'close session', icon: 'close' },
    { label: 'c', description: 'compact · preserve group placement', icon: 'fold',
      tooltip: 'Same as typing /compact in the session' },
    { label: '⇧C', description: 'fresh context · keep group and role', icon: 'clear-all',
      tooltip: 'Same as typing /clear in a Claude Code session' },
    { label: '⇧R', description: 'restart & resume · picks up a Claude Code / pi update', icon: 'debug-restart' },
    { label: '⇧⏎', description: 'prompt newline in Claude terminal', icon: 'newline' },
  ] },
  { label: 'Mouse', icon: 'inspect', children: [
    { label: 'click', description: 'open · focus work session', icon: 'go-to-file' },
    { label: 'drag', description: 'row or map card · group under session · drop on empty = top level', icon: 'gripper' },
    { label: 'right-click', description: 'all session actions', icon: 'menu' },
  ] },
  { label: 'Views', description: 'title-bar buttons · click to run', icon: 'layout', children: [
    { label: 'Map', description: 'click node · select work session', icon: 'type-hierarchy',
      command: 'pengupool.showMap' },
    { label: 'Log', description: 'messages in selected session tree', icon: 'output',
      command: 'pengupool.showLog' },
    { label: 'Run all', description: 'resume every previous session after a restart', icon: 'run-all',
      command: 'pengupool.resumePrevious' },
    { label: 'Cards', description: 'map cards refresh phase chain · context use', icon: 'pulse' },
  ] },
];

export class HintsProvider implements vscode.TreeDataProvider<Hint> {
  getChildren(element?: Hint): Hint[] { return element?.children ?? HINTS; }
  getTreeItem(hint: Hint): vscode.TreeItem {
    const state = hint.children
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(hint.label, state);
    item.description = hint.description;
    item.tooltip = hint.tooltip ?? (hint.description ? `${hint.label} — ${hint.description}` : undefined);
    if (hint.icon) { item.iconPath = new vscode.ThemeIcon(hint.icon); }
    if (hint.command) { item.command = { command: hint.command, title: hint.label }; }
    return item;
  }
}
