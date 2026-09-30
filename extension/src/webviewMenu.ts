import * as vscode from 'vscode';
import { SessionNode } from './serveClient';

/**
 * The context menu the Sessions list and the map both offer, so a right-click means the same thing in
 * either view. The menu itself lives in the webview (VS Code has no host-side menu for one), and every
 * item posts `{type:'command', command, id}` back here: the extension host keeps the allowlist in
 * `runMenuCommand`, so a webview can ask for these commands and no others.
 */
export const MENU_CSS = `
  #menu { position:fixed; z-index:10; min-width:210px; padding:4px 0; display:none;
    color:var(--vscode-menu-foreground); background:var(--vscode-menu-background);
    border:1px solid var(--vscode-menu-border, var(--vscode-widget-border));
    box-shadow:0 2px 8px var(--vscode-widget-shadow); }
  #menu button { display:block; width:100%; height:24px; padding:2px 24px; text-align:left; border:0;
    color:inherit; background:none; font:inherit; }
  #menu button:hover, #menu button:focus { color:var(--vscode-menu-selectionForeground);
    background:var(--vscode-menu-selectionBackground); outline:none; }
  #menu hr { margin:4px 0; border:0; border-top:1px solid var(--vscode-menu-separatorBackground); }
`;

export const MENU_HTML = `<div id="menu" role="menu"></div>`;

/**
 * Webview script for the menu. `showMenu(event, id, revealLabel)` opens it at the pointer: with a
 * session id it lists the session actions, without one the pool actions. Needs `MENU_HTML` in the
 * document and a `vscode` API object in scope; the caller selects the target itself, because a list row
 * and a map card highlight differently.
 */
export const MENU_JS = `
  const menu = document.getElementById('menu');
  let menuId = '';
  const command = (name, id=menuId) => vscode.postMessage({type:'command', command:name, id});
  function hideMenu(){ menu.style.display='none'; menu.innerHTML=''; }
  function addMenuItem(label, cmd){
    const button=document.createElement('button'); button.type='button'; button.role='menuitem';
    button.textContent=label; button.dataset.command=cmd; button.addEventListener('click',()=>{ hideMenu(); command(cmd); });
    menu.appendChild(button);
  }
  function showMenu(event, id, revealLabel){
    event.preventDefault(); event.stopPropagation(); menuId=id||'';
    hideMenu();
    addMenuItem('New Session', 'pengupool.new');
    addMenuItem('Add Previous Session…', 'pengupool.add');
    addMenuItem('Resume Previous Sessions…', 'pengupool.resumePrevious');
    if(id){
      menu.appendChild(document.createElement('hr'));
      addMenuItem('Open / Focus Session', 'pengupool.switch');
      addMenuItem(revealLabel, 'pengupool.reveal');
      addMenuItem('Group Under…', 'pengupool.group');
      addMenuItem('Rename', 'pengupool.rename');
      addMenuItem('Describe Role…', 'pengupool.describe');
      addMenuItem('Compact (/compact)', 'pengupool.compact');
      addMenuItem('Restart & Resume (Shift+R)', 'pengupool.restart');
      menu.appendChild(document.createElement('hr'));
      addMenuItem('Close', 'pengupool.close');
    }
    menu.style.display='block';
    const box=menu.getBoundingClientRect();
    menu.style.left=Math.max(2,Math.min(event.clientX,innerWidth-box.width-2))+'px';
    menu.style.top=Math.max(2,Math.min(event.clientY,innerHeight-box.height-2))+'px';
    menu.querySelector('button')?.focus();
  }
  document.addEventListener('pointerdown',event=>{ if(!menu.contains(event.target)) hideMenu(); });
  document.addEventListener('keydown',event=>{ if(event.key==='Escape') hideMenu(); });
  // Neither view shows editable text, so VS Code's default cut/copy/paste menu is only ever in the way:
  // a right-click that opened no menu of ours must not leave the system one behind.
  document.addEventListener('contextmenu',event=>{ if(!event.defaultPrevented) event.preventDefault(); });
`;

/** Pool-wide menu items: they need no session, so a right-click on empty space offers them alone. */
const GLOBAL_COMMANDS = new Set(['pengupool.new', 'pengupool.add', 'pengupool.resumePrevious']);

/** Session menu items. `pengupool.switch` takes the id; the rest take the node, as they do everywhere. */
const SESSION_COMMANDS = new Set([
  'pengupool.switch', 'pengupool.reveal', 'pengupool.group', 'pengupool.rename', 'pengupool.describe',
  'pengupool.compact', 'pengupool.restart', 'pengupool.close',
]);

/** Run a command a webview's context menu asked for, and report whether it was allowed. The menu lives in
 *  the webview, so this allowlist is what keeps a webview from running arbitrary commands. */
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
  await vscode.commands.executeCommand(command, command === 'pengupool.switch' ? node.id : node);
  return true;
}
