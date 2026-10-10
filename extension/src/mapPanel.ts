import * as vscode from 'vscode';
import { Snapshot } from './serveClient';
import { CTX_LEVEL_CSS, CTX_LEVEL_JS, SESSION_STATES, SESSION_STATE_CSS } from './sessionState';
import { HarnessTabs, HARNESS_TABS_CSS, HARNESS_TABS_HTML, HARNESS_TABS_JS } from './harness';
import { SESSION_CONTEXT_JS } from './webviewMenu';
import { runCtl } from './util';

/**
 * Live map as an editor-area webview (an editor tab, so it can be moved into a new/floating window or
 * tiled beside the code). Each group is laid out on its own (dagre) inside a frame, and the frames wrap to
 * the panel's width; a group folds down to its lead. Layout is recomputed ONLY when `topo_hash`, a card's
 * size, a fold or the panel width changes; other ticks restyle nodes in place, so the 1 Hz refresh stays
 * jump-free. Roomy cards show the workflow chain; compact ones leave it to the tooltip.
 */
export class MapPanel {
  private static current?: MapPanel;
  private readonly panel: vscode.WebviewPanel;
  private last?: Snapshot;
  private selectedId = '';
  private readonly tabs = new HarnessTabs();

  static toggle(ctx: vscode.ExtensionContext, last?: Snapshot): void {
    if (MapPanel.current) { MapPanel.current.panel.dispose(); return; }
    MapPanel.show(ctx, last, vscode.ViewColumn.Beside);
  }

  /** Reveal the map without turning an already-open map into a close action. */
  static show(
    ctx: vscode.ExtensionContext,
    last?: Snapshot,
    column: vscode.ViewColumn = vscode.ViewColumn.Beside,
  ): MapPanel {
    if (MapPanel.current) {
      MapPanel.current.panel.reveal(column);
      if (last) { MapPanel.current.update(last); }
      return MapPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'pengupoolMap', 'PenguPool Map', column,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] },
    );
    MapPanel.current = new MapPanel(panel, ctx);
    if (last) { MapPanel.current.update(last); }
    return MapPanel.current;
  }

  static showIfOpen(): MapPanel | undefined { return MapPanel.current; }

  private constructor(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext) {
    this.panel = panel;
    const dagre = panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'dagre.min.js'));
    this.panel.webview.html = html(panel.webview, dagre);
    this.panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'ready') {
        this.render();
        void this.sendPool();
        if (this.selectedId) { void this.panel.webview.postMessage({ type: 'selection', id: this.selectedId }); }
      }
      if (message?.type === 'select' && typeof message.id === 'string') {
        void vscode.commands.executeCommand('pengupool.switch', message.id);
      }
      // Refresh: redraw from the last snapshot now, and restart `pengupool serve` so a fresh process
      // rebuilds the whole model from disk (sessions, transcripts, roles, chains) and sends it in full.
      if (message?.type === 'refresh') { this.render(); void this.sendPool(); void vscode.commands.executeCommand('pengupool.refresh'); }
      if (message?.type === 'tab' && this.tabs.pick(message.harness)) { this.render(); }
      // Drag a card onto another to group it there, or onto empty canvas for the top level, as in the
      // Sessions list. ctl refuses a loop or a cross-harness group; its reason is shown as-is.
      if (message?.type === 'group' && typeof message.source === 'string' && typeof message.target === 'string') {
        void runCtl(['group', message.source, message.target]).then((r) => {
          if (r.code !== 0) { void vscode.window.showErrorMessage(`PenguPool: ${r.stderr || 'group failed'}`); }
        });
      }
      // The in-map banner posts apply and discard. Grouping decides who may message whom, so a
      // session may propose a regroup but never apply one.
      if (message?.type === 'applyGroupPlan') { void vscode.commands.executeCommand('pengupool.groupPlan'); }
      if (message?.type === 'discardGroupPlan') { void vscode.commands.executeCommand('pengupool.groupPlan.discard'); }
      // The background menu offers Fold All or Unfold All, whichever the map's fold state calls for, and neither
      // on a map with no groups; the webview is the only side that knows it, so it reports each change.
      if (message?.type === 'foldState' && ['none', 'open', 'folded'].includes(message.fold)) {
        void vscode.commands.executeCommand('setContext', 'pengupool.mapFold', message.fold);
      }
      // The skill-repo drawer. A repo dropped on the map starts a session there through the usual prompts.
      if (message?.type === 'poolDrop' && typeof message.dir === 'string') { void vscode.commands.executeCommand('pengupool.newIn', message.dir); }
      if (message?.type === 'poolAdd') { void this.poolAdd(); }
      if (message?.type === 'poolRm' && typeof message.dir === 'string') { void this.poolRun(['pool', 'rm', message.dir]); }
      if (message?.type === 'worktreeRm' && typeof message.path === 'string') { void this.worktreeRm(message.path); }
    });
    this.panel.onDidDispose(() => {
      // the key is window-wide, so a closed map must not hand its state to the next one
      void vscode.commands.executeCommand('setContext', 'pengupool.mapFold', 'none');
      if (MapPanel.current === this) { MapPanel.current = undefined; }
    });
  }

  update(snap: Snapshot): void {
    this.last = snap;
    this.render();
  }

  /** Fold or unfold a session's children on the map (`id` empty: every group), from the right-click menu. */
  fold(id: string, on: boolean): void {
    void this.panel.webview.postMessage({ type: 'fold', id, on });
  }

  select(id: string): void {
    this.selectedId = id;
    this.render();   // with no tab picked, the map follows the selected session's harness
    void this.panel.webview.postMessage({ type: 'selection', id });
  }

  private render(): void {
    if (!this.last) { return; }
    const { tabs, snapshot } = this.tabs.view(this.last, this.selectedId);
    void this.panel.webview.postMessage(tabs);
    void this.panel.webview.postMessage(snapshot);
  }

  // `ctl pool ls` is the drawer's whole state, reloaded after every pool action.
  private async sendPool(): Promise<void> {
    const r = await runCtl(['pool', 'ls']);
    let repos: unknown = [];
    try { repos = JSON.parse(r.stdout || '[]'); } catch { /* an older backend without the pool */ }
    void this.panel.webview.postMessage({ type: 'pool', repos });
  }

  private async poolRun(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const r = await runCtl(args);
    if (r.code !== 0 && r.code !== 4) { void vscode.window.showErrorMessage(`PenguPool: ${r.stderr || args.join(' ') + ' failed'}`); }
    await this.sendPool();
    return r;
  }

  private async poolAdd(): Promise<void> {
    const dir = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Add skill repo' });
    if (dir?.length) { await this.poolRun(['pool', 'add', dir[0].fsPath]); }
  }

  // Remove a skill-repo worktree. Unmerged (exit 4) asks first; the user's yes is the merge approval:
  // squash-merge its PR, remove the worktree, release the repo.
  private async worktreeRm(wt: string): Promise<void> {
    let r = await this.poolRun(['worktree-rm', wt]);
    if (r.code === 4) {
      const go = 'Squash-merge, release, and remove';
      const pick = await vscode.window.showWarningMessage(
        `${r.stderr}. Squash-merge its PR into main, cut a release, then remove the worktree?`, { modal: true }, go);
      if (pick !== go) { return; }
      r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'PenguPool: merging and releasing…' },
        () => this.poolRun(['worktree-rm', wt, '--merge']));
    }
    if (r.code === 0 && r.stdout) { void vscode.window.showInformationMessage(`PenguPool: ${r.stdout}`); }
  }
}

function html(webview: vscode.Webview, dagreUri: vscode.Uri): string {
  const nonce = Math.random().toString(36).slice(2);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html,body { margin:0; height:100%; background: var(--vscode-editor-background); color: var(--vscode-foreground);
              font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  #wrap { position:absolute; inset:0; overflow:auto; isolation:isolate; }  /* cards never paint over the menu */
  .edge { stroke: var(--vscode-descriptionForeground); stroke-opacity:.75; fill:none; stroke-width:2;
          stroke-linejoin:round; }  /* not panel-border: too faint for edges */
  /* a tree line lights up while a message travels on it: the Log's green down, milky blue for a reply */
  .edge { transition: stroke 300ms, stroke-width 300ms; }
  .edge.hot-down { stroke:#3fb950; stroke-opacity:1; stroke-width:3; }
  .edge.hot-up { stroke:#9ecbff; stroke-opacity:1; stroke-width:3; }
  .elabel { fill: var(--vscode-descriptionForeground); font-size:9px; }
  .emask { fill: var(--vscode-editor-background); }   /* keeps the line from bleeding through a label */
  .node.lone .box { stroke-dasharray:4,4; }
  .eyebrow { fill: var(--vscode-descriptionForeground); font-size:9px; letter-spacing:.14em; }
  .hull { opacity:.07; } .hull rect { fill: var(--vscode-foreground); stroke:none; }
  .frame { fill: var(--vscode-editorWidget-background); fill-opacity:.35; stroke: var(--vscode-panel-border); rx:10; }
  .box { stroke:var(--state-color, var(--vscode-panel-border)); stroke-width:1.5; rx:6;
         fill: var(--vscode-editorWidget-background); transition: stroke 200ms; }
  .selection { fill:none; stroke:transparent; stroke-width:2; rx:8; pointer-events:none; }
  .node.selected .selection { stroke:var(--vscode-focusBorder); }
  .node { cursor:pointer; }
  .node:hover .box, .node:focus .box { stroke-width:2.5; }
  .node:focus .selection { stroke:var(--vscode-focusBorder); }
  .node:focus { outline:none; }
  .node { user-select:none; touch-action:none; }
  body.dragging, body.dragging .node { cursor:grabbing; }
  .node.dragsrc { opacity:.5; }
  .node.drop .box { stroke:var(--vscode-focusBorder); stroke-width:3; stroke-dasharray:none; }
  .state { color:var(--state-color); font-size:10px; line-height:14px; font-weight:600; }
  ${SESSION_STATE_CSS}
  ${CTX_LEVEL_CSS}
  .chip { position:absolute; top:6px; right:8px; font-size:8px; line-height:11px; letter-spacing:.08em;
          padding:0 3px; border:1px solid currentColor; border-radius:2px; opacity:.7;
          color:var(--vscode-descriptionForeground); }
  .content { position:relative; box-sizing:border-box; width:100%; height:100%; padding:6px 10px; overflow:hidden;
             display:flex; flex-direction:column; justify-content:center; }
  .nm { color:var(--vscode-editor-foreground, var(--vscode-foreground)); font-weight:600;
        line-height:14px; overflow-wrap:anywhere; display:-webkit-box; -webkit-box-orient:vertical;
        -webkit-line-clamp:2; overflow:hidden; }
  .meta { color:var(--vscode-descriptionForeground); font-size:10px; line-height:14px;
          white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .content.has-fold { padding-right:26px; }
  .fold { position:absolute; right:4px; bottom:4px; min-width:18px; height:16px; padding:0 4px;
          border:1px solid var(--vscode-panel-border);
          border-radius:3px; font:inherit; font-size:11px; line-height:14px; cursor:pointer; background:none;
          color:var(--vscode-descriptionForeground); }
  .fold:hover { background:var(--vscode-toolbar-hoverBackground); color:var(--vscode-foreground); }
  .fold.urgent { color:var(--state-color); font-weight:600; }   /* a folded-away session needs you */
  .box.stack { fill-opacity:.6; }   /* a folded group reads as a stack of cards */
  .chain { font-size:10px; line-height:14px; overflow-wrap:anywhere; flex-shrink:0; }
  .probe { position:absolute; visibility:hidden; left:-10000px; top:0; height:auto; }
  .wprobe { position:absolute; visibility:hidden; left:-10000px; top:0; white-space:nowrap; display:inline-block; }
  #tools { position:absolute; top:4px; right:8px; z-index:2; display:flex; gap:4px; }
  #tools button { cursor:pointer; padding:2px 8px; border-radius:3px;
             border:1px solid var(--vscode-button-border, transparent); font:inherit; font-size:11px;
             background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
  #tools select { font:inherit; font-size:11px; padding:1px 4px; border-radius:3px;
             border:1px solid var(--vscode-dropdown-border, transparent);
             background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); }
  #tools button:hover { background:var(--vscode-button-secondaryHoverBackground); }
  #empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
           color: var(--vscode-descriptionForeground); }
  /* Regrouping banner: a one-click apply / discard strip the user cannot miss. */
  #regroupBanner { display:none; position:absolute; top:8px; left:50%; transform:translateX(-50%);
    z-index:5; max-width:calc(100% - 32px); padding:6px 10px; gap:8px; align-items:center;
    background:var(--vscode-editorWidget-background); border:1px solid var(--vscode-panel-border);
    border-radius:4px; box-shadow:0 2px 8px rgba(0,0,0,.25); font-size:11px; }
  #regroupBanner.shown { display:flex; }
  #regroupBanner .label { font-weight:600; }
  #regroupBanner .moves { color:var(--vscode-descriptionForeground); margin-left:4px; }
  #regroupBanner button { cursor:pointer; padding:2px 10px; border-radius:3px; font:inherit; font-size:11px;
    border:1px solid var(--vscode-button-border, transparent); }
  #regroupBanner button.apply { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  #regroupBanner button.discard { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
  ${HARNESS_TABS_CSS}
  #tabs { position:absolute; top:0; left:0; right:0; z-index:1; height:28px; box-sizing:border-box; }
  body.tabbed #wrap, body.tabbed #empty { top:28px; }
  #legend { position:absolute; left:0; right:0; bottom:0; height:24px; box-sizing:border-box; padding:0 12px; display:none;
            gap:16px; align-items:center; font-size:10px; color:var(--vscode-descriptionForeground);
            border-top:1px solid var(--vscode-panel-border); background:var(--vscode-editor-background); }
  #legend svg { vertical-align:middle; margin-right:4px; }
  #wrap { bottom:24px; }
  #svg { margin-top:28px; }   /* below the toolbar */
  /* skill-repo drawer on the right: a tab when closed, a list when open */
  #pool { position:absolute; top:32px; right:0; bottom:24px; z-index:2; display:flex; align-items:flex-start; pointer-events:none; }
  #pool > * { pointer-events:auto; }
  #poolToggle { writing-mode:vertical-rl; cursor:pointer; padding:8px 3px; font:inherit; font-size:11px; color:inherit;
                background:var(--vscode-sideBar-background, var(--vscode-editor-background));
                border:1px solid var(--vscode-panel-border); border-right:none; border-radius:3px 0 0 3px; }
  #poolBody { display:none; width:220px; height:100%; overflow:auto; box-sizing:border-box; padding:6px;
              background:var(--vscode-sideBar-background, var(--vscode-editor-background)); border-left:1px solid var(--vscode-panel-border); }
  #pool.open #poolBody { display:block; }
  .poolRepo, .poolWt { display:flex; align-items:center; gap:4px; padding:3px 4px; border-radius:3px; }
  .poolRepo { cursor:grab; user-select:none; }
  .poolWt { padding-left:16px; font-size:11px; color:var(--vscode-descriptionForeground); }
  .poolRepo:hover, .poolWt:hover { background:var(--vscode-list-hoverBackground); }
  .poolRepo .nm, .poolWt .nm { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .poolRepo.missing { cursor:default; } .poolRepo.missing .nm { text-decoration:line-through; opacity:.6; }
  #pool button.x { cursor:pointer; border:none; background:none; color:inherit; padding:0 4px; }
  #poolAdd { margin-top:6px; width:100%; cursor:pointer; padding:3px; border-radius:3px; font:inherit; font-size:11px;
             color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); border:none; }
  #poolEmpty { padding:4px; font-size:11px; color:var(--vscode-descriptionForeground); }
  body.pooldrag, body.pooldrag * { cursor:copy !important; }
</style></head><body>
${HARNESS_TABS_HTML}
<div id="regroupBanner">
  <span class="label">Regrouping (<span id="rgCount"></span>)</span>
  <span class="moves" id="rgMoves"></span>
  <button class="apply" id="rgApply">Apply</button>
  <button class="discard" id="rgDiscard">Discard</button>
</div>
<div id="tools">
  <select id="layout" title="How each group is drawn"></select>
  <button id="spacing" title="Compact: tight spacing, chains in the tooltip. Roomy: wide spacing, chains on the cards"></button>
  <button id="foldAll" title="Fold every group to its lead, or unfold them all"></button>
  <button id="refresh" title="Reload all sessions from disk and redraw the map">⟳ Refresh</button>
</div>
<div id="empty">no sessions</div>
<div id="wrap"><svg id="svg" width="100%" height="100%"><g id="scene"></g></svg></div>
<div id="pool"><button id="poolToggle" aria-expanded="false" title="Skill repos: drag one onto the map to start a session in it">Skill repos</button>
<div id="poolBody"><div id="poolList"></div><button id="poolAdd">+ Add skill repo…</button></div></div>
<div id="legend">
  <span><svg width="18" height="8"><path d="M0,4 H18" class="edge"/></svg>parent → child</span>
  <span><svg width="18" height="8"><path d="M0,4 H18" class="edge hot-down"/></svg>message sent</span>
  <span><svg width="18" height="8"><path d="M0,4 H18" class="edge hot-up"/></svg>reply</span>
  <span><svg width="14" height="10"><rect x="1" y="1" width="12" height="8" rx="2" class="box" style="stroke:var(--vscode-descriptionForeground); stroke-dasharray:3,2"/></svg>ungrouped</span>
</div>
<script nonce="${nonce}" src="${dagreUri}"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const scene = document.getElementById('scene');
  const empty = document.getElementById('empty');
  const legend = document.getElementById('legend');
  const SVGNS = 'http://www.w3.org/2000/svg';
  const HTMLNS = 'http://www.w3.org/1999/xhtml';
  const states = ${JSON.stringify(SESSION_STATES)};
  ${CTX_LEVEL_JS}
  ${SESSION_CONTEXT_JS}
  let topo = null, sizes = '', last = null;
  let selected = '';
  const nodeEls = new Map(), edgeEls = new Map();   // edges keyed parent>child

  function flat(roots){ const o=[]; const w=n=>{o.push(n); n.children.forEach(w);}; roots.forEach(w); return o; }
  function edges(roots){
    const tree = []; const w = n => n.children.forEach(c => { tree.push([n.id, c.id, c.label||'']); w(c); });
    roots.forEach(w); return tree;
  }
  // A path through right-angle points with each bend rounded (r=6, less where a segment is short).
  function rounded(pts){
    pts = pts.filter((p,i) => !i || p[0]!==pts[i-1][0] || p[1]!==pts[i-1][1]);
    const toward = (a,b,r) => { const d=Math.hypot(b[0]-a[0], b[1]-a[1])||1; return [a[0]+(b[0]-a[0])*r/d, a[1]+(b[1]-a[1])*r/d]; };
    let d = 'M'+pts[0][0]+','+pts[0][1];
    for(let i=1; i<pts.length-1; i++){
      const [p,c,n] = [pts[i-1], pts[i], pts[i+1]];
      const r = Math.min(6, Math.hypot(c[0]-p[0], c[1]-p[1])/2, Math.hypot(n[0]-c[0], n[1]-c[1])/2);
      const a = toward(c,p,r), b = toward(c,n,r);
      d += ' L'+a[0]+','+a[1]+' Q'+c[0]+','+c[1]+' '+b[0]+','+b[1];
    }
    const e = pts[pts.length-1]; return d+' L'+e[0]+','+e[1];
  }
  // Map options, kept per panel: layout, spacing, and which sessions are folded to hide their children.
  const LAYOUTS = { org:'Org chart', outline:'Outline', down:'Tree ↓', right:'Tree →' };
  const SPACINGS = { compact:'Compact', roomy:'Roomy' };
  const saved = vscode.getState?.() || {};
  const opts = Object.assign({ layout:'org', spacing:'roomy' }, saved.opts);
  if(!LAYOUTS[saved.opts?.layout]) opts.layout = saved.opts?.dir==='LR' ? 'right' : 'org';   // saved before layouts had names
  const folded = new Set(saved.folded || []);
  let poolOpen = !!saved.poolOpen;
  function save(){ vscode.setState?.({ opts, folded:[...folded], poolOpen }); }
  // Inside a group: sib between siblings, rank between a parent and its children, stack between stacked
  // cards. Roomy frames each group (pad inside, gap between frames); compact packs the groups as close as
  // their cards and lines allow, gap apart.
  function spacing(){ const roomy = opts.spacing==='roomy', across = opts.layout==='right';
    return roomy ? { sib: across ? 24 : 32, rank: across ? 120 : 56, stack: 12, pad: 20, gap: 40 }
                 : { sib: across ? 8 : 12, rank: across ? 80 : 36, stack: 8, pad: 0, gap: 16 }; }  // →: labels run along
  // The tree as drawn: a folded session keeps its card but loses its children, which \`hidden\` lists.
  function visible(roots){
    const hidden = {}, below = n => n.children.flatMap(c => [c, ...below(c)]);
    const cut = n => folded.has(n.id) && n.children.length ? (hidden[n.id] = below(n), { ...n, children: [], folds: true })
                                                           : { ...n, children: n.children.map(cut), folds: n.children.length > 0 };
    return { roots: roots.map(cut), hidden };
  }
  function setFold(id, on){ if(on === folded.has(id)) return; on ? folded.add(id) : folded.delete(id); save(); redraw(); }
  function foldAll(on){ if(!last) return; folded.clear();
    if(on) flat(last.roots).forEach(n => { if(n.children.length) folded.add(n.id); }); save(); redraw(); }

  // Each layout turns one group into a block: cards { id: {x, y, width, height} } with x/y the card's
  // centre, routes [[parent, child, points]] of right-angled lines, and the block's w and h. Every line
  // leaves its parent, turns on a bus or spine and enters the child; none runs diagonally.
  const bottomOf = c => c.y + c.height/2, topOf = c => c.y - c.height/2, leftOf = c => c.x - c.width/2;
  function shift(b, dx, dy){
    Object.values(b.cards).forEach(c => { c.x += dx; c.y += dy; });
    b.routes.forEach(r => r[2] = r[2].map(([x, y]) => [x+dx, y+dy]));
    return b;
  }
  // Org chart: subtrees side by side under their parent; a family of three or more sessions without
  // children of their own stacks in a column on a spine, so a wide fan never stretches the map.
  function org(n, S){
    const me = cardSize(n), leaves = n.children.filter(c => !c.children.length);
    const stack = leaves.length >= 3, row = [];
    n.children.filter(c => !stack || c.children.length).forEach(c => row.push(org(c, S)));
    if(stack){ const col = { cards: {}, routes: [], w: 0, h: 0, spine: 8 };
      leaves.forEach(c => { const s = cardSize(c);
        col.cards[c.id] = { ...s, x: 20 + s.width/2, y: col.h + s.height/2 };
        col.h += s.height + S.stack; col.w = Math.max(col.w, 20 + s.width); });
      col.h -= S.stack; row.push(col); }
    const rowW = row.reduce((w, b) => w + b.w, 0) + S.sib * Math.max(0, row.length - 1);
    const only = row.length === 1 && row[0].spine != null;   // just a column: it hangs from the parent's left
    const w = only ? Math.max(me.width, 8 + row[0].w) : Math.max(me.width, rowW);
    const P = { ...me, x: only ? me.width/2 : w/2, y: me.height/2 };
    const out = { cards: { [n.id]: P }, routes: [], w, h: me.height };
    if(!row.length) return out;
    let x = only ? 8 : (w - rowW)/2; const y = me.height + S.rank, bus = me.height + S.rank/2;
    row.forEach(b => { shift(b, x, y); Object.assign(out.cards, b.cards); out.routes.push(...b.routes);
      if(b.spine != null){ const sx = x + b.spine, from = only ? [[sx, bottomOf(P)]] : [[P.x, bottomOf(P)], [P.x, bus], [sx, bus]];
        Object.entries(b.cards).forEach(([id, c]) => out.routes.push([n.id, id, [...from, [sx, c.y], [leftOf(c), c.y]]])); }
      else { const id = Object.keys(b.cards).find(k => !b.routes.some(r => r[1] === k)), c = b.cards[id];
        out.routes.push([n.id, id, [[P.x, bottomOf(P)], [P.x, bus], [c.x, bus], [c.x, topOf(c)]]]); }
      out.h = Math.max(out.h, y + b.h); x += b.w + S.sib; });
    return out;
  }
  // Outline: one column per group, each child indented under its parent and hung off its spine.
  function outline(r, S){
    const out = { cards: {}, routes: [], w: 0, h: 0 };
    const walk = (n, depth, parent) => { const s = cardSize(n), x = depth * 24;
      const c = out.cards[n.id] = { ...s, x: x + s.width/2, y: out.h + s.height/2 };
      if(parent){ const sx = leftOf(parent) + 12; out.routes.push([parent.id, n.id, [[sx, bottomOf(parent)], [sx, c.y], [leftOf(c), c.y]]]); }
      out.h += s.height + S.stack; out.w = Math.max(out.w, x + s.width);
      c.id = n.id; n.children.forEach(k => walk(k, depth + 1, c)); };
    walk(r, 0, null); out.h -= S.stack;
    return out;
  }
  // Tree ↓ / Tree →: dagre ranks the group; lines turn on a bus between the ranks. Parents side by side
  // whose buses would overlap get their own lane, 8px further out, so no line runs along another family's.
  function geometry(boxes, H){
    const at = id => { const n=boxes[id]; return { main:H?n.y:n.x, side:H?n.x:n.y, hm:(H?n.height:n.width)/2 }; };
    return { pt: (m, s) => H ? [s, m] : [m, s], at };
  }
  function buses(G, tree){
    const kids = {}, rank = {}, bus = {};
    tree.forEach(([a,b]) => (kids[a] ||= []).push(b));
    Object.keys(kids).forEach(a => { const sides = [a, ...kids[a]].map(id => G.at(id).side);
      (rank[Math.round(G.at(a).main)] ||= []).push({ a, lo: Math.min(...sides), hi: Math.max(...sides) }); });
    Object.values(rank).forEach(row => { const ends = [];   // ends[k]: where lane k is free again
      row.sort((p,q) => p.lo-q.lo).forEach(p => { let k = ends.findIndex(e => e + 8 < p.lo); if(k < 0) k = ends.length;
        ends[k] = p.hi; const A = G.at(p.a), near = Math.min(...kids[p.a].map(b => G.at(b).main - G.at(b).hm));
        bus[p.a] = Math.min(A.main + A.hm + 12 + 8*k, near - 8); }); });
    return bus;
  }
  function ranked(r, S){
    const H = opts.layout === 'down', g = new dagre.graphlib.Graph(); g.setDefaultEdgeLabel(()=>({}));
    g.setGraph({ rankdir: H ? 'TB' : 'LR', nodesep: S.sib, ranksep: S.rank, marginx: 0, marginy: 0 });
    flat([r]).forEach(n => g.setNode(n.id, cardSize(n)));
    const tree = edges([r]); tree.forEach(([a,b]) => g.setEdge(a,b));
    dagre.layout(g);
    const cards = {}; g.nodes().forEach(id => { const n = g.node(id); cards[id] = { width:n.width, height:n.height, x:n.x, y:n.y }; });
    const G = geometry(cards, H), bus = buses(G, tree);
    const routes = tree.map(([a, b]) => { const A = G.at(a), B = G.at(b);
      return [a, b, [G.pt(A.main+A.hm, A.side), G.pt(bus[a], A.side), G.pt(bus[a], B.side), G.pt(B.main-B.hm, B.side)]]; });
    return { cards, routes, w: g.graph().width, h: g.graph().height };
  }
  const LAYOUT = { org, outline, down: ranked, right: ranked };

  // Compact packing: a group's outline is a box per family, a parent with its children, so groups tuck
  // under each other's shallow parts but never into a family's span. Each block takes the highest, then
  // leftmost, spot where its outline stays gap clear of everything placed; spots are tried at the left
  // margin and just past the edges already placed.
  function rectsOf(b){
    const box = cs => [Math.min(...cs.map(leftOf)), Math.min(...cs.map(topOf)),
                       Math.max(...cs.map(c => leftOf(c) + c.width)), Math.max(...cs.map(bottomOf))];
    const kids = {}; b.routes.forEach(([a, k]) => (kids[a] ||= [b.cards[a]]).push(b.cards[k]));
    const fams = Object.values(kids);
    return fams.length ? fams.map(box) : Object.values(b.cards).map(c => box([c]));
  }
  function pack(blocks, avail, gap){
    const placed = [], spot = [];
    const hit = (rs, x, y) => rs.some(([a, b, c, d]) => placed.some(([e, f, g, h]) =>
      a + x < g + gap && c + x + gap > e && b + y < h + gap && d + y + gap > f));
    blocks.forEach(b => { const rs = rectsOf(b);
      const xs = [0, ...placed.map(r => r[2] + gap)].filter(x => x === 0 || x + b.w <= avail);
      const ys = [0, ...placed.map(r => r[3] + gap)];
      const cand = ys.flatMap(y => xs.map(x => [x, y])).sort((p, q) => p[1] - q[1] || p[0] - q[0]);
      const [x, y] = cand.find(([x, y]) => !hit(rs, x, y)) || [0, Math.max(0, ...placed.map(r => r[3] + gap))];
      // ponytail: candidate scan is O(spots² × rects); fine for a pool of dozens, grid-index it past hundreds
      placed.push(...rs.map(([a, b2, c, d]) => [a + x, b2 + y, c + x, d + y])); spot.push([x, y]); });
    return spot;
  }
  // Card size MEASURED from the real fonts (dagre needs sizes before layout): an offscreen card holds
  // the same content and styles. ctx% is sized as "100%" so a changing percentage never relayouts.
  const probe = hel('div',{class:'content probe'}); const wprobe = hel('span',{class:'wprobe'});
  document.body.appendChild(probe); document.body.appendChild(wprobe);
  function textW(text, cls){ wprobe.className='wprobe '+cls; wprobe.textContent=text; return wprobe.getBoundingClientRect().width; }
  const chainOf = n => opts.spacing==='roomy' && n.status || '';
  function cardSize(n){
    const meta = (n.harness==='pi'?'pi · ':'') + (n.ctx_pct!=null?'100% · ':'') + (n.repo||'');
    const chain = chainOf(n), fold = n.folds;
    const width = chain ? 260 : 180;   // two widths only, so the cards of a row line up
    probe.className = 'content probe' + (fold ? ' has-fold' : '');
    probe.style.width = width+'px'; probe.innerHTML = '';
    [['state','● Active'], ['nm', n.name], ['meta', meta], ['chain', chain]].forEach(([cls, text]) => {
      if(!text) return; const d=hel('div',{class:cls}); d.textContent=text; probe.appendChild(d); });
    return { width, height: Math.ceil(probe.getBoundingClientRect().height) + 2 };
  }
  function sizeKey(roots){ return flat(roots).map(n => { const c=cardSize(n); return n.id+':'+c.width+'x'+c.height; }).join(); }
  function el(tag, attrs){ const e=document.createElementNS(SVGNS,tag); for(const k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function hel(tag, attrs){ const e=document.createElementNS(HTMLNS,tag); for(const k in attrs) e.setAttribute(k, attrs[k]); return e; }

  function relayout(snap){
    scene.innerHTML=''; nodeEls.clear(); edgeEls.clear();
    const { roots } = visible(snap.roots), nodes = flat(roots);
    empty.style.display = nodes.length ? 'none' : 'flex';
    legend.style.display = nodes.length ? 'flex' : 'none';
    if(!nodes.length) return;
    // Every group is laid out alone, so no family's lines cross another's. Roomy frames each group and
    // fills rows of frames to the panel's width, with the ungrouped sessions in a last row under a
    // heading. Compact packs groups and ungrouped cards alike as tightly as they fit.
    const S = spacing(), M = 12, roomy = opts.spacing === 'roomy';
    const avail = Math.max(360, (wrap.clientWidth || 0) - 2*M);
    const lead = new Set(roots.filter(r => r.folds).map(r => r.id));
    const lone = new Set(lead.size ? roots.filter(r => !lead.has(r.id)).map(r => r.id) : []);
    const one = n => { const c = cardSize(n); return { cards: { [n.id]: { ...c, x: c.width/2, y: c.height/2 } }, routes: [], w: c.width, h: c.height }; };
    const blocks = roots.filter(r => lead.has(r.id)).map(r => shift(LAYOUT[opts.layout](r, S), S.pad, S.pad));
    blocks.forEach(b => { b.w += 2*S.pad; b.h += 2*S.pad; b.frame = roomy; });
    const rest = roots.filter(r => !lead.has(r.id));
    if(roomy && rest.length){   // one block: a heading, then the cards in rows
      const head = lead.size ? 20 : 0, b = { cards: {}, routes: [], w: 0, h: 0, own: true, heading: head > 0 };
      let x = 0, y = head, rowH = 0;
      rest.forEach(n => { const c = cardSize(n);
        if(x && x + c.width > avail){ x = 0; y += rowH + S.sib; rowH = 0; }
        b.cards[n.id] = { ...c, x: x + c.width/2, y: y + c.height/2 };
        x += c.width + S.sib; b.w = Math.max(b.w, x - S.sib); rowH = Math.max(rowH, c.height); });
      b.h = y + rowH; blocks.push(b);
    } else rest.forEach(n => blocks.push(one(n)));
    let width = 0, height = 0;
    if(roomy){ let x = 0, y = 0, rowH = 0;
      blocks.forEach(b => { if(x && (b.own || x + b.w > avail)){ x = 0; y += rowH + S.gap; rowH = 0; }
        b.at = [x, y]; x += b.w + S.gap; rowH = Math.max(rowH, b.h); }); }
    else { // biggest groups first, so the small ones and the ungrouped cards fill the gaps they leave
      const order = blocks.map((b, i) => i).sort((i, j) => (blocks[j].routes.length > 0) - (blocks[i].routes.length > 0)
                                                     || blocks[j].w * blocks[j].h - blocks[i].w * blocks[i].h);
      pack(order.map(i => blocks[i]), avail, S.gap).forEach((p, k) => { blocks[order[k]].at = p; }); }
    const boxes = {}, routes = [];
    blocks.forEach(b => { const [x, y] = [b.at[0] + M, b.at[1] + M]; shift(b, x, y);
      if(b.frame) scene.appendChild(el('rect', { class:'frame', x, y, width:b.w, height:b.h, rx:10 }));
      // packed tight, a group is told apart by a faint tint under its cards and lines; the layer's
      // opacity, not each rect's, keeps overlaps from showing darker
      if(!roomy && b.routes.length){ const hull = el('g', { class:'hull' });
        rectsOf(b).forEach(([a, t, c, d]) => hull.appendChild(el('rect', { x:a-6, y:t-6, width:c-a+12, height:d-t+12, rx:8 })));
        scene.appendChild(hull); }
      if(b.heading){ const t = el('text', { class:'eyebrow', x, y:y+10 }); t.textContent = 'UNGROUPED'; scene.appendChild(t); }
      Object.assign(boxes, b.cards); routes.push(...b.routes);
      width = Math.max(width, x + b.w + M); height = Math.max(height, y + b.h + M); });
    // edges first (under nodes); restyle lights them up as messages travel
    const label = {}; edges(roots).forEach(([a, b, l]) => { label[a+'>'+b] = l; });
    routes.forEach(([a, b, pts]) => { const path = el('path', {class:'edge', d:rounded(pts)});
      scene.appendChild(path); edgeEls.set(a+'>'+b, path); });
    // labels over the edges, each on a mask 6px off the last segment into the child, cut to the room
    // there: beside a drop, or above a run into the card's side (a short run leaves it to the tooltip)
    routes.forEach(([a, b, pts]) => { const l = label[a+'>'+b], c = boxes[b]; if(!l) return;
      const [j, end] = pts.slice(-2), drop = j[0] === end[0];
      const room = drop ? c.width/2 + 60 : Math.abs(end[0]-j[0]) - 12;
      let text = l; while(text.length > 1 && textW(text,'elabel') > room) text = text.slice(0,-2)+'…';
      if(text.length < 3) return;
      const w = Math.ceil(textW(text,'elabel'));
      const x = drop ? j[0]+6 : Math.min(j[0],end[0])+6, y = drop ? end[1]-18 : j[1]-18;
      scene.appendChild(el('rect', {class:'emask', x, y, width:w+4, height:12, rx:2}));
      const t=el('text',{class:'elabel', x:x+2, y:y+9}); t.textContent=text; scene.appendChild(t);
      const tip=el('title',{}); tip.textContent=l; t.appendChild(tip); });
    nodes.forEach(n => {
      const nd=boxes[n.id]; const gx=nd.x-nd.width/2, gy=nd.y-nd.height/2;
      const grp=el('g',{class:'node state-'+n.state+(lone.has(n.id)?' lone':''), transform:'translate('+gx+','+gy+')', tabindex:'0', role:'button', 'aria-label':'Open '+n.name, 'data-id':n.id});
      const ring=el('rect',{class:'selection', x:-3, y:-3, width:nd.width+6, height:nd.height+6, rx:8});
      const rect=el('rect',{class:'box', width:nd.width, height:nd.height, rx:6});
      const title=el('title',{}); title.textContent=n.name;
      const body=el('foreignObject',{x:0, y:0, width:nd.width, height:nd.height});
      const content=hel('div',{class:'content'+(n.folds?' has-fold':'')});
      const state=hel('div',{class:'state'}); const nm=hel('div',{class:'nm'}); const meta=hel('div',{class:'meta'});
      const harness=hel('span',{}), ctx=hel('span',{class:'ctx'}), repo=hel('span',{});  // ctx% is colored by level
      meta.appendChild(harness); meta.appendChild(ctx); meta.appendChild(repo);
      const chain=hel('div',{class:'chain'});
      if(lead.has(n.id)){ const chip=hel('span',{class:'chip'}); chip.textContent='LEAD'; content.appendChild(chip); }
      content.appendChild(state); content.appendChild(nm); content.appendChild(meta); content.appendChild(chain); body.appendChild(content);
      let fold = null;
      if(n.folds){ fold = hel('button',{class:'fold', type:'button', tabindex:'-1'}); content.appendChild(fold);
        fold.addEventListener('pointerdown', ev => ev.stopPropagation());   // a press on the toggle never starts a drag
        fold.addEventListener('click', ev => { ev.stopPropagation(); setFold(n.id, !folded.has(n.id)); }); }
      // the right-click menu is VS Code's own, so it draws over the terminal and every other panel
      sessionContext(grp, n.id, { foldable: !!n.folds, folded: folded.has(n.id) });
      const select=()=>vscode.postMessage({type:'select', id:n.id});
      grp.addEventListener('click', select);
      // A right-click highlights the card as if selected, without switching to it, under the menu.
      grp.addEventListener('contextmenu', () => {
        selected = n.id;
        nodeEls.forEach((e, id) => e.grp.classList.toggle('selected', id === n.id));
      });
      grp.addEventListener('keydown', ev=>{ if(ev.key==='Enter'||ev.key===' '){ ev.preventDefault(); select(); }
        if(n.folds && (ev.key==='ArrowLeft' ? !folded.has(n.id) : ev.key==='ArrowRight' && folded.has(n.id))){
          ev.preventDefault(); setFold(n.id, !folded.has(n.id)); document.querySelector('.node[data-id="'+n.id+'"]')?.focus(); } });
      grp.appendChild(ring);
      if(folded.has(n.id)) grp.appendChild(el('rect',{class:'box stack', x:4, y:4, width:nd.width, height:nd.height, rx:6}));
      grp.appendChild(rect); grp.appendChild(title); grp.appendChild(body); scene.appendChild(grp);
      nodeEls.set(n.id, {grp, title, state, nm, meta, harness, ctx, repo, chain, fold, lone: lone.has(n.id)});
    });
    document.getElementById('svg').setAttribute('viewBox', '0 0 '+width+' '+height);
    document.getElementById('svg').setAttribute('width', width); document.getElementById('svg').setAttribute('height', height);
  }

  // A tree line stays lit for HOT_MS after the latest message on it: green parent → child, blue for the
  // reply. Messages between sessions that aren't parent and child stay in the Log only.
  const HOT_MS = 90000;
  function restyleEdges(snap, now){
    const id = {}; flat(snap.roots).forEach(n => { id[n.name] = n.id; });
    const hot = {};
    (snap.msgs||[]).forEach(([ts, src, dst]) => { const a=id[src], b=id[dst], t=Date.parse(ts);
      if(!a || !b || !(now - t < HOT_MS)) return;
      const k = edgeEls.has(a+'>'+b) ? a+'>'+b : edgeEls.has(b+'>'+a) ? b+'>'+a : '';
      if(k && !(hot[k] && hot[k].t > t)) hot[k] = { t, dir: k === a+'>'+b ? 'hot-down' : 'hot-up' }; });
    edgeEls.forEach((path, k) => path.setAttribute('class', 'edge' + (hot[k] ? ' '+hot[k].dir : '')));
  }
  function renderRegroupBanner(snap){
    const banner = document.getElementById('regroupBanner');
    const p = snap.group_plan;
    if (!p || !p.moves || !p.moves.length) { banner.classList.remove('shown'); return; }
    document.getElementById('rgCount').textContent = p.moves.length === 1 ? '1 move' : p.moves.length + ' moves';
    document.getElementById('rgMoves').textContent = p.moves.map((m) => m.label).join(' · ');
    banner.classList.add('shown');
  }
  const URGENT = ['blocked', 'waiting'];
  let reportedFold = '';
  function restyle(snap, now = Date.now()){
    restyleEdges(snap, now);
    const { hidden } = visible(snap.roots), groups = flat(snap.roots).filter(n => n.children.length);
    const fb = document.getElementById('foldAll');
    const fold = !groups.length ? 'none' : groups.every(n => folded.has(n.id)) ? 'folded' : 'open';
    fb.style.display = groups.length ? '' : 'none';
    fb.textContent = fold === 'folded' ? '▾ Unfold all' : '▸ Fold all';
    if(fold !== reportedFold){ reportedFold = fold; vscode.postMessage({type:'foldState', fold}); }
    flat(snap.roots).forEach(n => {
      const e = nodeEls.get(n.id); if(!e) return;
      const visual=states[n.state]||{symbol:'·',label:n.state};
      e.grp.setAttribute('class', 'node state-'+n.state+(e.lone?' lone':'')+(selected===n.id?' selected':'')+dragClass(n.id));
      e.grp.setAttribute('aria-label','Open '+n.name+', '+visual.label);
      e.state.textContent=visual.symbol+' '+visual.label;
      e.nm.textContent = n.name;
      e.harness.textContent = n.harness==='pi' ? 'pi · ' : '';
      e.ctx.textContent = n.ctx_pct!=null ? n.ctx_pct+'%' : '';
      e.ctx.className = n.ctx_pct!=null ? 'ctx '+ctxLevel(n.ctx_pct) : 'ctx';
      e.repo.textContent = (n.ctx_pct!=null ? ' · ' : '') + (n.repo||'');
      e.chain.textContent = chainOf(n);
      e.chain.style.display = chainOf(n) ? '' : 'none';   // no chain, no reserved space
      if(e.fold){ const h = hidden[n.id];
        // folded: how many it hides, in the colour of the most pressing state among them
        const urgent = h && URGENT.find(st => h.some(c => c.state === st));
        e.fold.className = 'fold' + (urgent ? ' urgent state-'+urgent : '');
        e.fold.textContent = h ? '▸ '+h.length : '▾';
        e.fold.title = h ? 'Show '+h.map(c => c.name).join(', ') : 'Fold '+n.name+' to hide its children'; }
      e.title.textContent = n.name + ' · '+visual.label + (n.repo ? ' · '+n.repo : '') + (n.status ? '\\n'+n.status : '');
    });
  }

  ${HARNESS_TABS_JS}
  window.addEventListener('message', ev => {
    if(ev.data?.type==='tabs') return;
    if(ev.data?.type==='pool'){ drawPool(ev.data.repos || []); return; }
    if(ev.data?.type==='fold'){ ev.data.id ? setFold(ev.data.id, ev.data.on) : foldAll(ev.data.on); return; }
    if(ev.data?.type==='selection'){
      selected=ev.data.id;
      nodeEls.forEach((e,id)=>e.grp.classList.toggle('selected', id===selected));
      return;
    }
    const snap = last = ev.data;
    const key = sizeKey(visible(snap.roots).roots);
    if(snap.topo_hash !== topo || key !== sizes || fresh){ fresh = false; topo = snap.topo_hash; sizes = key; relayout(snap); }
    restyle(snap);
    renderRegroupBanner(snap);
  });
  // Refresh: forget the cached layout and redraw now, then reload everything from the backend and
  // lay the map out again from that fresh snapshot, even when its structure did not change.
  let fresh = false;
  function redraw(){ topo = null; sizes = ''; if(last){ relayout(last); restyle(last); } }
  function showOpts(){
    document.getElementById('layout').value = opts.layout;
    document.getElementById('spacing').textContent = SPACINGS[opts.spacing];
  }
  function setOpt(k, v){ opts[k] = v; save(); showOpts(); redraw(); }
  const layoutPick = document.getElementById('layout');
  Object.entries(LAYOUTS).forEach(([k, label]) => { const o = hel('option', { value: k }); o.textContent = label; layoutPick.appendChild(o); });
  layoutPick.addEventListener('change', () => setOpt('layout', layoutPick.value));
  document.getElementById('spacing').addEventListener('click', () => setOpt('spacing', opts.spacing==='compact' ? 'roomy' : 'compact'));
  document.getElementById('foldAll').addEventListener('click', () => {
    if(last) foldAll(reportedFold !== 'folded'); });
  showOpts();
  document.getElementById('refresh').addEventListener('click', () => { fresh = true; redraw(); vscode.postMessage({type:'refresh'}); });
  document.getElementById('rgApply').addEventListener('click', () => vscode.postMessage({type:'applyGroupPlan'}));
  document.getElementById('rgDiscard').addEventListener('click', () => vscode.postMessage({type:'discardGroupPlan'}));
  // Drag to regroup: pointer events, since SVG cards take no HTML5 drag. Past 6px a press is a drag, not a
  // click; the drop goes to the card under the pointer, or to the top level on empty canvas.
  let drag = null, dropId = '', justDragged = false;
  const wrap = document.getElementById('wrap');
  function dragClass(id){ return drag?.on ? (id===drag.id ? ' dragsrc' : id===dropId ? ' drop' : '') : ''; }
  function under(ev){ const t=document.elementFromPoint(ev.clientX, ev.clientY);
    return { id: t?.closest('.node')?.dataset.id || '', canvas: !!t && wrap.contains(t) }; }
  function markDrag(){ nodeEls.forEach((e, id) => { e.grp.classList.toggle('dragsrc', !!drag?.on && id===drag.id);
    e.grp.classList.toggle('drop', !!drag?.on && id===dropId); }); document.body.classList.toggle('dragging', !!drag?.on); }
  function endDrag(){ drag=null; dropId=''; markDrag(); }
  wrap.addEventListener('pointerdown', ev => {
    const id = ev.button===0 && ev.target.closest('.node')?.dataset.id;
    if(id) drag={id, x:ev.clientX, y:ev.clientY, on:false}; });
  wrap.addEventListener('pointermove', ev => {
    if(!drag || (!drag.on && Math.hypot(ev.clientX-drag.x, ev.clientY-drag.y) < 6)) return;
    if(!drag.on) wrap.setPointerCapture?.(ev.pointerId);   // only a drag captures: a plain click stays on its card
    drag.on = true; const t = under(ev).id; dropId = t!==drag.id ? t : ''; markDrag(); });
  wrap.addEventListener('pointerup', ev => {
    const d = drag; endDrag(); if(!d?.on) return;
    justDragged = true; setTimeout(() => { justDragged = false; });
    const t = under(ev);
    if(t.id ? t.id!==d.id : t.canvas) vscode.postMessage({type:'group', source:d.id, target:t.id}); });
  wrap.addEventListener('pointercancel', endDrag);
  wrap.addEventListener('click', ev => { if(justDragged){ ev.stopPropagation(); justDragged=false; } }, true);
  // Skill-repo drawer. Drag a repo onto the map to start a session in it (the empty map's notice counts);
  // × on a worktree removes it (asking to merge first when it is not merged), × on a repo drops it from the pool.
  const pool = document.getElementById('pool'), poolList = document.getElementById('poolList');
  const poolToggle = document.getElementById('poolToggle');
  function showPool(){ pool.classList.toggle('open', poolOpen); poolToggle.setAttribute('aria-expanded', String(poolOpen)); }
  poolToggle.addEventListener('click', () => { poolOpen = !poolOpen; save(); showPool(); });
  document.getElementById('poolAdd').addEventListener('click', () => vscode.postMessage({type:'poolAdd'}));
  function xButton(label, msg){ const b = hel('button', { class:'x', title:label, 'aria-label':label }); b.textContent = '×';
    b.addEventListener('click', ev => { ev.stopPropagation(); vscode.postMessage(msg); }); return b; }
  function poolRow(cls, name, title){ const row = hel('div', { class:cls, title }); const nm = hel('span', { class:'nm' });
    nm.textContent = name; row.appendChild(nm); return row; }
  function drawPool(repos){
    poolList.replaceChildren();
    if(!repos.length){ const e = hel('div', { id:'poolEmpty' }); e.textContent = 'No skill repos yet.'; poolList.appendChild(e); }
    repos.forEach(r => {
      const row = poolRow('poolRepo' + (r.missing ? ' missing' : ''), r.name,
        r.missing ? r.repo + ' is gone' : r.repo + '\\nDrag onto the map to start a session here');
      row.dataset.dir = r.repo;
      row.appendChild(xButton('Remove ' + r.name + ' from the pool', {type:'poolRm', dir:r.repo}));
      poolList.appendChild(row);
      (r.worktrees || []).forEach(w => {
        const wt = poolRow('poolWt', w.branch.replace(/^pengupool\\//, ''), w.path);
        wt.appendChild(xButton('Remove this worktree', {type:'worktreeRm', path:w.path}));
        poolList.appendChild(wt);
      });
    });
  }
  let poolDrag = null;
  function endPoolDrag(){ poolDrag = null; document.body.classList.remove('pooldrag'); }
  poolList.addEventListener('pointerdown', ev => {
    const row = ev.button===0 && !ev.target.closest('button') && ev.target.closest('.poolRepo:not(.missing)');
    if(row) poolDrag = { dir: row.dataset.dir, row, x: ev.clientX, y: ev.clientY, on: false }; });
  poolList.addEventListener('pointermove', ev => {
    if(!poolDrag || poolDrag.on || Math.hypot(ev.clientX-poolDrag.x, ev.clientY-poolDrag.y) < 6) return;
    poolDrag.on = true; poolDrag.row.setPointerCapture?.(ev.pointerId); document.body.classList.add('pooldrag'); });
  poolList.addEventListener('pointerup', ev => {
    const d = poolDrag; endPoolDrag(); if(!d?.on) return;
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    if(t && (wrap.contains(t) || t.id==='empty')) vscode.postMessage({type:'poolDrop', dir:d.dir}); });
  poolList.addEventListener('pointercancel', endPoolDrag);
  showPool();
  // Empty canvas: the pool actions, as on the list's background, and folding every group.
  poolContext(document.body, { map: true });
  // snapshots arrive only when something changes, so a quiet pool still needs its lit lines to go out
  window.setInterval?.(() => { if(last) restyleEdges(last, Date.now()); }, 5000);
  document.fonts?.ready.then(redraw);   // sizes measured before the editor font loaded are wrong
  // the blocks wrap to the panel's width, so a resize that changes it lays them out again
  let laidW = 0, resizing;
  if(window.ResizeObserver) new window.ResizeObserver(() => { if(Math.abs(wrap.clientWidth - laidW) < 24) return; laidW = wrap.clientWidth;
    clearTimeout(resizing); resizing = setTimeout(redraw, 120); }).observe(wrap);
  vscode.postMessage({type:'ready'});
</script></body></html>`;
}
