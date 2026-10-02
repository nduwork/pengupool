import * as vscode from 'vscode';
import { SessionNode } from './serveClient';

/**
 * The context menu the Sessions list and the map both offer, so a right-click means the same thing in
 * either view. The menu itself lives in the webview (VS Code has no host-side menu for one), and every
 * item posts `{type:'command', command, id}` back here: the extension host keeps the allowlist in
 * `runMenuCommand`, so a webview can ask for these commands and no others.
 */
export const MENU_CSS = `
  #menu { position:fixed; z-index:10; min-width:230px; padding:4px; display:none;
    color:var(--vscode-menu-foreground); background:var(--vscode-menu-background);
    border:1px solid var(--vscode-menu-border, var(--vscode-widget-border)); border-radius:6px;
    box-shadow:0 4px 16px var(--vscode-widget-shadow); }
  #menu.open { display:block; animation:menu-in 90ms ease-out; }
  @keyframes menu-in { from { opacity:0; transform:translateY(-2px); } }
  @media (prefers-reduced-motion: reduce) { #menu.open { animation:none; } }
  #menu button { display:grid; grid-template-columns:16px 1fr auto; align-items:center; gap:8px;
    width:100%; height:26px; padding:0 8px; text-align:left; border:0; border-radius:4px;
    color:inherit; background:none; font:inherit; cursor:pointer; }
  #menu button svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.2;
    stroke-linecap:round; stroke-linejoin:round; opacity:0.85; }
  #menu button kbd { font:inherit; font-size:0.85em; opacity:0.6; letter-spacing:0.04em; }
  #menu button:hover, #menu button:focus { color:var(--vscode-menu-selectionForeground);
    background:var(--vscode-menu-selectionBackground); outline:none; }
  #menu button.danger svg { stroke:var(--vscode-errorForeground); opacity:1; }
  #menu button.danger:hover svg, #menu button.danger:focus svg { stroke:currentColor; }
  #menu hr { margin:4px 6px; border:0; border-top:1px solid var(--vscode-menu-separatorBackground); }
`;

export const MENU_HTML = `<div id="menu" role="menu"></div>`;

/**
 * Webview script for the menu. `showMenu(event, id, revealLabel)` opens it at the pointer: with a
 * session id it lists the session actions, without one the pool actions. Needs `MENU_HTML` in the
 * document and a `vscode` API object in scope; the caller selects the target itself, because a list row
 * and a map card highlight differently. Each item carries a 16px stroke icon and the key that runs it in
 * the Sessions list; arrow keys, Home and End move between items.
 */
export const MENU_JS = `
  const menu = document.getElementById('menu');
  let menuId = '';
  const command = (name, id=menuId) => vscode.postMessage({type:'command', command:name, id});
  const MENU_ICONS = {
    add: 'M8 3v10M3 8h10',
    history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3l2 1.5',
    'run-all': 'M2.5 3.5 7 8l-4.5 4.5zM8 3.5 12.5 8 8 12.5z',
    open: 'M9 2.5h4.5v11H9M2 8h8M7 5l3 3-3 3',
    folder: 'M1.5 4h4.5l1.5 1.5h7v7.5h-13z',
    tree: 'M3.5 2.5v9h3M3.5 6h3M9 4.5h5M9 11.5h5',
    edit: 'M10.5 2.5l3 3-8 8h-3v-3z',
    note: 'M3 2h10v12H3zM5.5 5h5M5.5 7.5h5M5.5 10h3',
    fold: 'M8 1.5v4M6 3.5l2 2 2-2M8 14.5v-4M6 12.5l2-2 2 2M3 8h10',
    restart: 'M13 8a5 5 0 1 1-1.5-3.6M12 1.5v3h-3',
    close: 'M4 4l8 8M12 4l-8 8',
  };
  function hideMenu(){ menu.classList.remove('open'); menu.innerHTML=''; }
  function addMenuItem(label, cmd, icon, key, danger){
    const button=document.createElement('button'); button.type='button'; button.role='menuitem';
    button.dataset.command=cmd; if(danger) button.classList.add('danger');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 16 16');
    svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d', MENU_ICONS[icon]||'');
    svg.appendChild(path);
    const text=document.createElement('span'); text.textContent=label;
    const hint=document.createElement('kbd'); hint.textContent=key||'';
    button.append(svg, text, hint);
    button.addEventListener('click',()=>{ hideMenu(); command(cmd); });
    button.addEventListener('pointermove',()=>{ if(document.activeElement!==button) button.focus(); });
    menu.appendChild(button);
  }
  function showMenu(event, id, revealLabel){
    event.preventDefault(); event.stopPropagation(); menuId=id||'';
    hideMenu();
    addMenuItem('New Session', 'pengupool.new', 'add', 'N');
    addMenuItem('Add Previous Session…', 'pengupool.add', 'history', 'A');
    addMenuItem('Resume Previous Sessions…', 'pengupool.resumePrevious', 'run-all');
    if(id){
      menu.appendChild(document.createElement('hr'));
      addMenuItem('Open / Focus Session', 'pengupool.switch', 'open', '⏎');
      addMenuItem(revealLabel, 'pengupool.reveal', 'folder');
      menu.appendChild(document.createElement('hr'));
      addMenuItem('Group Under…', 'pengupool.group', 'tree', 'G');
      addMenuItem('Rename', 'pengupool.rename', 'edit', 'R');
      addMenuItem('Describe Role…', 'pengupool.describe', 'note', 'D');
      menu.appendChild(document.createElement('hr'));
      addMenuItem('Compact (/compact)', 'pengupool.compact', 'fold', 'C');
      addMenuItem('Restart & Resume', 'pengupool.restart', 'restart', '⇧R');
      menu.appendChild(document.createElement('hr'));
      addMenuItem('Close', 'pengupool.close', 'close', 'X', true);
    }
    menu.classList.add('open');
    const box=menu.getBoundingClientRect();
    menu.style.left=Math.max(2,Math.min(event.clientX,innerWidth-box.width-2))+'px';
    menu.style.top=Math.max(2,Math.min(event.clientY,innerHeight-box.height-2))+'px';
    menu.querySelector('button')?.focus();
  }
  menu.addEventListener('keydown',event=>{
    const items=[...menu.querySelectorAll('button')];
    const at=items.indexOf(document.activeElement);
    const next={ArrowDown:at+1, ArrowUp:at-1, Home:0, End:items.length-1}[event.key];
    if(next===undefined||!items.length) return;
    event.preventDefault(); event.stopPropagation();
    items[(next+items.length)%items.length].focus();
  });
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
