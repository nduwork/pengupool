import * as vscode from 'vscode';
import { Harness, SessionNode } from './serveClient';
import { SessionsProvider } from './sessionsTree';
import { TerminalManager } from './terminals';
import { ExplorerFollow } from './explorer';
import { runCtl } from './util';
import { SessionsView } from './sessionsView';
import { MapPanel } from './mapPanel';
import { LogPanel } from './logPanel';

const LAST_ADD_PATH_KEY = 'pengupool.lastAddPath';
const HARNESS_LABEL: Record<Harness, string> = { cc: 'Claude Code', pi: 'pi' };

/** "3 h ago" for a session's last update, so the restore list reads as a timeline. */
export function ago(at: number): string {
  const minutes = (Date.now() - at) / 60_000;
  if (minutes < 1) { return 'just now'; }
  if (minutes < 60) { return `${Math.floor(minutes)} min ago`; }
  const hours = minutes / 60;
  if (hours < 24) { return `${Math.floor(hours)} h ago`; }
  const days = hours / 24;
  return days < 30 ? `${Math.floor(days)} d ago` : `${Math.floor(days / 30)} mo ago`;
}

export function lastAddDirectory(context: vscode.ExtensionContext, fallback: vscode.Uri): vscode.Uri {
  const saved = context.globalState.get<string>(LAST_ADD_PATH_KEY);
  return saved ? vscode.Uri.file(saved) : fallback;
}

export async function rememberAddDirectory(context: vscode.ExtensionContext, directory: vscode.Uri): Promise<void> {
  await context.globalState.update(LAST_ADD_PATH_KEY, directory.fsPath);
}

/** What VS Code passes a command run from a webview's right-click menu: the tag on what was clicked. */
interface MenuContext { webview?: string; sessionId?: string }

interface Deps {
  provider: SessionsProvider;
  terminals: TerminalManager;
  tree: SessionsView;
  explorer: ExplorerFollow;
}

function descendants(node: SessionNode): Set<string> {
  const ids = new Set<string>();
  const walk = (n: SessionNode) => { ids.add(n.id); n.children.forEach(walk); };
  walk(node);
  return ids;
}

/** Rebuild the pool after a reboot: the backend lists every session it can still resume, and the
 *  editor puts the ticked ones back on the tmux server (windows first, then one to look at). */
export function registerCommands(context: vscode.ExtensionContext, d: Deps): void {
  // A session arrives as its node, its id, or the right-click tag a webview put on it (`sessionId`).
  const sel = (node?: SessionNode | string | MenuContext): SessionNode | undefined =>
    typeof node === 'string' ? d.provider.find(node)
      : node && 'sessionId' in node ? d.provider.find(node.sessionId ?? '')
      : (node as SessionNode | undefined) ?? d.tree.selection[0];
  const defaultDir = (): vscode.Uri =>
    vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.env.HOME || '/');

  const reg = (id: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('pengupool.switch', async (node?: SessionNode | string) => {
    const n = sel(node);
    if (n) {
      void d.tree.reveal(n, { select: true, focus: false, expand: true });
      MapPanel.showIfOpen()?.select(n.id);
      LogPanel.showIfOpen()?.select(n.id);
      // Before the terminal takes focus, so revealing the folder never pulls typing out of the session.
      await d.explorer.follow(n.cwd);
      void d.terminals.switchTo(n);
    }
  });

  // Folding hides a session's children in the view the menu was opened in.
  const fold = (on: boolean) => (ctx?: MenuContext) => {
    if (!ctx?.sessionId) { return; }
    if (ctx.webview === 'pengupoolMap') { MapPanel.showIfOpen()?.fold(ctx.sessionId, on); } else { SessionsView.fold(ctx.sessionId, on); }
  };
  reg('pengupool.fold', fold(true));
  reg('pengupool.unfold', fold(false));
  reg('pengupool.foldAll', () => MapPanel.showIfOpen()?.fold('', true));
  reg('pengupool.unfoldAll', () => MapPanel.showIfOpen()?.fold('', false));

  reg('pengupool.reveal', async (node?: SessionNode | string) => {
    const n = sel(node);
    if (!n) { return; }
    if (!n.cwd) { vscode.window.showErrorMessage(`PenguPool: "${n.name}" has no folder to reveal.`); return; }
    // The OS file manager is how you inspect a session's folder by hand; VS Code's Explorer shows
    // the same action as "Reveal in Finder" / "Open Containing Folder".
    try {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(n.cwd));
    } catch (err) {
      vscode.window.showErrorMessage(`PenguPool: cannot open ${n.cwd} (${String((err as Error)?.message ?? err)})`);
    }
  });

  reg('pengupool.quickSwitch', async () => {
    const items = d.provider.all.map((n) => ({ label: n.name, description: `${n.repo} · ${n.state}`, node: n }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Switch to session…' });
    if (pick) { void vscode.commands.executeCommand('pengupool.switch', pick.node.id); }
  });

  // From a session's right-click menu the new session becomes its child, so it runs the parent's harness:
  // harnesses never share a tree. A repo dropped from the map's skill-repo drawer comes with its folder.
  const newSession = async (parent?: SessionNode, preset?: string) => {
    const dir = preset ? [vscode.Uri.file(preset)] : await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      defaultUri: defaultDir(), openLabel: 'New session here',
    });
    if (!dir?.length) { return; }
    const name = await vscode.window.showInputBox({ prompt: 'Session name', value: dir[0].path.split('/').pop() });
    if (!name) { return; }
    const placement = await vscode.window.showQuickPick([
      { label: 'Use selected folder', description: 'no new worktree · fine if a session already runs here', value: 'folder' },
      { label: 'Create a worktree', description: 'isolated branch for this session', value: 'worktree' },
    ], { placeHolder: 'Choose where to start the session' });
    if (!placement) { return; }
    const harness = parent ? parent.harness ?? 'cc' : (await vscode.window.showQuickPick(
      (['cc', 'pi'] as Harness[]).map((value) => ({ label: HARNESS_LABEL[value], value })),
      { placeHolder: 'Choose the agent harness' },
    ))?.value;
    if (!harness) { return; }
    await d.terminals.newSession(dir[0].fsPath, name, harness, placement.value === 'worktree', parent?.id);
  };
  reg('pengupool.new', () => newSession());
  reg('pengupool.newChild', (node?: SessionNode) => { const n = sel(node); return n && newSession(n); });
  reg('pengupool.newIn', (dir: string) => newSession(undefined, dir));

  const addPrevious = async (parent?: SessionNode) => {
    const dir = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      defaultUri: lastAddDirectory(context, defaultDir()), openLabel: 'Add previous from here',
    });
    if (!dir?.length) { return; }
    await rememberAddDirectory(context, dir[0]);
    const r = await runCtl(['past', dir[0].fsPath]);
    if (r.code !== 0) { vscode.window.showErrorMessage(`PenguPool: ${r.stderr || 'no past sessions'}`); return; }
    let past: [string, string, Harness?][] = [];
    try { past = JSON.parse(r.stdout || '[]'); } catch { /* empty */ }
    if (parent) { past = past.filter(([, , harness = 'cc']) => harness === (parent.harness ?? 'cc')); }
    if (!past.length) { vscode.window.showInformationMessage('PenguPool: no past sessions in that folder.'); return; }
    const pick = await vscode.window.showQuickPick(
      past.map(([id, title, harness = 'cc']) => ({
        label: title, description: `${HARNESS_LABEL[harness] ?? harness} · ${id.slice(0, 8)}`, id, harness,
      })),
      { placeHolder: 'Resume which past session?' },
    );
    if (!pick) { return; }
    const name = await vscode.window.showInputBox({ prompt: 'Session name', value: pick.label.slice(0, 40) });
    if (!name) { return; }
    await d.terminals.resume(dir[0].fsPath, name, pick.id, pick.harness, parent?.id);
  };
  reg('pengupool.add', () => addPrevious());
  reg('pengupool.addChild', (node?: SessionNode) => { const n = sel(node); return n && addPrevious(n); });

  reg('pengupool.copyPath', async (node?: SessionNode) => {
    const n = sel(node);
    if (n?.cwd) { await vscode.env.clipboard.writeText(n.cwd); }
  });

  reg('pengupool.resumePrevious', async () => {
    const listed = await runCtl(['past-all']);
    if (listed.code !== 0) {
      vscode.window.showErrorMessage(`PenguPool: ${listed.stderr || 'could not list previous sessions'}`);
      return;
    }
    let past: [string, string, Harness, string, number][] = [];
    try { past = JSON.parse(listed.stdout || '[]'); } catch { /* no history */ }
    if (!past.length) {
      vscode.window.showInformationMessage('PenguPool: no previous sessions to resume.');
      return;
    }
    const items = past.map(([id, title, harness, cwd, updated]) => ({
      label: title,
      description: `${HARNESS_LABEL[harness] ?? harness} · ${cwd} · ${ago(updated)}`,
      picked: true, id, name: title, harness, cwd,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: `${items.length} session${items.length === 1 ? '' : 's'} can be resumed — untick what you don't want`,
    });
    if (!pick?.length) { return; }
    const failed: string[] = [];
    let first: typeof pick[number] | undefined;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'PenguPool: resuming sessions…' },
      async (progress) => {
        for (const [index, item] of pick.entries()) {
          progress.report({ message: `${index + 1}/${pick.length} · ${item.label}`, increment: 100 / pick.length });
          const resumed = await runCtl(['resume', item.cwd, item.name, item.id]);
          if (resumed.code === 0) { first = first ?? item; } else { failed.push(`${item.label}: ${resumed.stderr || 'failed'}`); }
        }
        // Bind this window's terminal last, so the bulk of the work never moves it.
        if (first) { await d.terminals.resume(first.cwd, first.name, first.id, first.harness); }
      });
    const resumed = pick.length - failed.length;
    if (failed.length) {
      vscode.window.showWarningMessage(
        `PenguPool: resumed ${resumed} of ${pick.length} — ${failed.slice(0, 2).join('; ')}`,
        'Show log',
      ).then((choice) => { if (choice === 'Show log') { void vscode.commands.executeCommand('pengupool.showLog'); } });
    } else {
      vscode.window.showInformationMessage(`PenguPool: resumed ${resumed} session${resumed === 1 ? '' : 's'}.`);
    }
  });

  reg('pengupool.group', async (node?: SessionNode) => {
    const n = sel(node);
    if (!n) { return; }
    const banned = descendants(n);
    const items: (vscode.QuickPickItem & { id: string })[] = [{ label: '(top level)', id: '' }];
    for (const c of d.provider.all) {
      // Harnesses live on separate tmux servers and never share a tree.
      if (!banned.has(c.id) && (c.harness ?? 'cc') === (n.harness ?? 'cc')) {
        items.push({ label: c.name, description: c.repo, id: c.id });
      }
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Move "${n.name}" under…` });
    if (!pick) { return; }
    const r = await runCtl(['group', n.id, pick.id]);
    if (r.code !== 0) { vscode.window.showErrorMessage(`PenguPool: ${r.stderr || 'group failed'}`); }
  });

  reg('pengupool.rename', async (node?: SessionNode) => {
    const n = sel(node);
    if (!n) { return; }
    const name = await vscode.window.showInputBox({ prompt: 'New name', value: n.name });
    if (!name || name === n.name) { return; }
    // ctl picks the command: pi-intercom's /alias (the name intercom addresses) for pi, /rename for Claude
    await d.terminals.slash(n, 'rename', name);
  });

  reg('pengupool.describe', async (node?: SessionNode) => {
    const n = sel(node);
    if (!n) { return; }
    let p: { summary?: string; responsibility?: string; description_editor?: string; updated_at?: string } = {};
    try { p = JSON.parse((await runCtl(['profile', n.id])).stdout || '{}'); } catch { /* no profile yet */ }
    const by = p.description_editor ? ` (last set by ${p.description_editor} ${p.updated_at ?? ''})` : '';
    const summary = await vscode.window.showInputBox({
      prompt: `One line: what "${n.name}" owns${by}`, value: p.summary ?? '',
      validateInput: (v) => (v.length > 120 ? 'At most 120 characters' : undefined),
    });
    if (summary === undefined) { return; }
    const responsibility = await vscode.window.showInputBox({
      prompt: 'Responsibility: a short private brief for the session', value: p.responsibility ?? '',
    });
    if (responsibility === undefined) { return; }
    const r = await runCtl(['describe', n.id, '--summary', summary, '--responsibility', responsibility]);
    if (r.code !== 0) { vscode.window.showErrorMessage(`PenguPool: ${r.stderr || 'describe failed'}`); }
  });

  reg('pengupool.compact', async (node?: SessionNode) => {
    const n = sel(node);
    if (n) { await d.terminals.slash(n, 'compact'); }
  });

  reg('pengupool.clear', async (node?: SessionNode) => {
    const n = sel(node);
    if (!n) { return; }
    if (n.harness === 'pi') { vscode.window.showWarningMessage('PenguPool: Fresh Context is for Claude Code sessions.'); return; }
    const ok = await vscode.window.showWarningMessage(
      `Clear "${n.name}"'s conversation? It keeps its place in the tree and its role.`, { modal: true }, 'Clear');
    if (ok) { await d.terminals.slash(n, 'clear'); }
  });

  reg('pengupool.restart', async (node?: SessionNode) => {
    const n = sel(node);
    if (!n) { return; }
    const ok = await vscode.window.showWarningMessage(
      `Restart "${n.name}"? Its current turn is interrupted, then it resumes in place ` +
      `with the installed ${HARNESS_LABEL[n.harness ?? 'cc']}.`, { modal: true }, 'Restart');
    if (ok) { await d.terminals.restart(n); }
  });

  reg('pengupool.close', async (node?: SessionNode) => {
    const n = sel(node);
    if (!n) { return; }
    const ok = await vscode.window.showWarningMessage(`Close "${n.name}"?`, { modal: true }, 'Close');
    if (ok) { await d.terminals.close(n); }
  });
}
