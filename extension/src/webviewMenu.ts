import * as vscode from 'vscode';
import { SessionNode } from './serveClient';

/**
 * The right-click menu of the Sessions list and the map is VS Code's own `webview/context` menu
 * (package.json), so it draws above the terminal and every other panel instead of being clipped to the
 * webview. A webview only tags what was clicked: `sessionContext` marks a row or card with its session,
 * `poolContext` marks the background. VS Code hands that tag to the chosen command as its argument, and
 * `commands.ts` resolves `sessionId` to the session.
 *
 * The keys `command(name, id)` sends from the Sessions list still come back as `{type:'command'}` and run
 * through `runMenuCommand`, whose allowlist keeps a webview to these commands and no others.
 */
export const SESSION_CONTEXT_JS = `
  const command = (name, id) => vscode.postMessage({type:'command', command:name, id});
  function sessionContext(el, id, extra){
    el.setAttribute('data-vscode-context', JSON.stringify({ webviewSection:'session', sessionId:id, preventDefaultContextMenuItems:true, ...extra }));
  }
  function poolContext(el, extra){
    el.setAttribute('data-vscode-context', JSON.stringify({ webviewSection:'pool', preventDefaultContextMenuItems:true, ...extra }));
  }
`;

/** Pool-wide commands: they need no session. */
const GLOBAL_COMMANDS = new Set(['pengupool.new', 'pengupool.add', 'pengupool.resumePrevious']);

/** Session commands: each takes the node, as it does everywhere. */
const SESSION_COMMANDS = new Set([
  'pengupool.newChild', 'pengupool.addChild', 'pengupool.reveal', 'pengupool.copyPath', 'pengupool.group',
  'pengupool.rename', 'pengupool.describe', 'pengupool.compact', 'pengupool.clear', 'pengupool.restart',
  'pengupool.close',
]);

/** Run a command a webview asked for, and report whether it was allowed: this allowlist is what keeps a
 *  webview from running arbitrary commands. */
export async function runMenuCommand(
  command: unknown,
  id: unknown,
  find: (id: string) => SessionNode | undefined,
  select?: (id: string) => void,
): Promise<boolean> {
  if (typeof command !== 'string') { return false; }
  if (GLOBAL_COMMANDS.has(command)) {
    await vscode.commands.executeCommand(command);
    return true;
  }
  if (!SESSION_COMMANDS.has(command) || typeof id !== 'string') { return false; }
  const node = find(id);
  if (!node) { return false; }
  select?.(node.id);
  await vscode.commands.executeCommand(command, node);
  return true;
}
