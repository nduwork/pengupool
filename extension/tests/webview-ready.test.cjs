const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadPanel(sourceName) {
  const posts = [], commands = [], ctl = [];
  let receive;
  const webview = {
    cspSource: 'vscode-resource:',
    html: '',
    asWebviewUri: (uri) => uri,
    postMessage: async (message) => { posts.push(message); return true; },
    onDidReceiveMessage: (callback) => { receive = callback; return { dispose() {} }; },
  };
  const panel = {
    webview,
    reveal() {},
    dispose() {},
    onDidDispose: () => ({ dispose() {} }),
  };
  const vscode = {
    ViewColumn: { One: 1, Beside: -2 },
    Uri: { joinPath: (...parts) => parts.join('/') },
    commands: { executeCommand: async (...args) => { commands.push(args); } },
    window: { createWebviewPanel: () => panel },
  };
  const load = (name) => {
    const filename = path.join(__dirname, '../src', name + '.ts');
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, require }, { filename });
    return exports;
  };
  const require = (id) => {
      if (id === 'vscode') return vscode;
      if (id === './harness') return load('harness');
      if (id === './serveClient') return {};
      if (id === './sessionState') return {
        SESSION_STATES: {
          active: { symbol: '●', label: 'Active' },
          waiting: { symbol: '◷', label: 'Waiting' },
          stale: { symbol: '○', label: 'Stale' },
          blocked: { symbol: '?', label: 'Approval' },
        },
        SESSION_STATE_CSS: '.state-active { --state-color: green; }',
        CTX_LEVEL_JS: load('sessionState').CTX_LEVEL_JS,   // the real level rule, so tests check it
        CTX_LEVEL_CSS: '',
      };
      if (id === './webviewMenu') return { SESSION_CONTEXT_JS: 'function sessionContext(){} function poolContext(){} const command=()=>{};', runMenuCommand: async () => true };
      if (id === './util') return {
        runCtl: async (args) => { ctl.push(args); return { code: 0, stdout: '', stderr: '' }; },
      };
      throw new Error('Unexpected dependency: ' + id);
  };
  const exports = load(sourceName);
  const data = () => posts.filter((message) => message?.type !== 'tabs' && message?.type !== 'selection');
  return {
    data, tabs: () => posts.filter((message) => message?.type === 'tabs'),
    exports, posts, commands, ctl,
    html: () => webview.html,
    send: (message) => receive(message),
    ready: () => receive({ type: 'ready' }),
  };
}

const snapshot = { roots: [], msgs: [['now', 'a', 'b', 'hello', false]], topo_hash: 'one' };

test('map replays the current snapshot when its webview becomes ready', () => {
  const h = loadPanel('mapPanel');
  h.exports.MapPanel.show({ extensionUri: 'extension' }, snapshot, 1);
  assert.equal(h.data().length, 1);
  h.ready();
  assert.equal(h.data().length, 2);
  assert.equal(h.data()[1].topo_hash, 'one');
});

test('map node messages invoke the same session switch command as the tree', () => {
  const h = loadPanel('mapPanel');
  h.exports.MapPanel.show({ extensionUri: 'extension' }, snapshot, 1);
  h.send({ type: 'select', id: 'session-1' });
  assert.deepEqual(h.commands[0], ['pengupool.switch', 'session-1']);
});

test('map keeps the selected session separate from its state', () => {
  const h = loadPanel('mapPanel');
  const panel = h.exports.MapPanel.show({ extensionUri: 'extension' }, snapshot, 1);
  panel.select('session-1');
  assert.equal(h.posts.at(-1).type, 'selection');
  assert.equal(h.posts.at(-1).id, 'session-1');
  assert.match(h.html(), /node\.selected \.selection/);
});

test('log replays current messages when its webview becomes ready', () => {
  const h = loadPanel('logPanel');
  h.exports.LogPanel.show(snapshot, 1);
  assert.equal(h.data().length, 1);
  h.ready();
  assert.equal(h.data().length, 2);
  assert.equal(h.data()[1][0][3], 'hello');
});

test('log timestamps use compact local system time', () => {
  const h = loadPanel('logPanel');
  const local = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(h.exports.localLogTime(local.toISOString()), '01/02/2026-03:04:05');
  assert.equal(h.exports.localLogTime('not-a-time'), 'not-a-time');
});

test('log explains message direction colors', () => {
  const h = loadPanel('logPanel');
  h.exports.LogPanel.show(snapshot, 1);
  assert.match(h.html(), /class="g">parent → child/);
  assert.match(h.html(), /class="b">child → parent/);
  assert.match(h.html(), /class="o">@session \(user-tagged\)/);
});

test('log rows preview one line and expand on click', () => {
  const h = loadPanel('logPanel');
  h.exports.LogPanel.show(snapshot, 1);
  const html = h.html();
  assert.match(html, /text-overflow:ellipsis/);          // one-line preview
  assert.match(html, /\.row\.open \.msg \{ white-space:pre-wrap/); // expand to full
  assert.match(html, /addEventListener\('click'/);       // click toggles expansion
  assert.match(html, /dataset\.k/);                     // open-state keyed per message
});

test('log clear button posts a clear and calls the backend clear-logs verb', () => {
  const h = loadPanel('logPanel');
  h.exports.LogPanel.show(snapshot, 1);
  assert.match(h.html(), /id="clear"/, 'renders a clear button');
  assert.match(h.html(), /postMessage\(\{type:'clear'\}\)/, 'wired to post to the extension');
  h.send({ type: 'clear' });
  // args come from the sandboxed webview realm, so compare primitives (cross-realm arrays are not
  // deepEqual across Node realms).
  assert.equal(h.ctl.length, 1);
  assert.equal(h.ctl[0].length, 1);
  assert.equal(h.ctl[0][0], 'clear-logs');
});

test('map session names use the editor theme foreground', () => {
  const h = loadPanel('mapPanel');
  h.exports.MapPanel.show({ extensionUri: 'extension' }, snapshot, 1);
  assert.match(h.html(), /\.nm \{ color:var\(--vscode-editor-foreground/);
});

test('map node labels stay inside bounded cards', () => {
  const h = loadPanel('mapPanel');
  h.exports.MapPanel.show({ extensionUri: 'extension' }, snapshot, 1);
  assert.match(h.html(), /overflow-wrap:anywhere/);
  assert.match(h.html(), /text-overflow:ellipsis/);
  assert.match(h.html(), /foreignObject/);
});

// A DOM just big enough for the map script: text is 6px per character, a card probe 14px per line + 12px padding.
function fakeDom() {
  const make = () => {
    const e = {
      style: {}, children: [], textContent: '', className: '',
      attrs: {}, setAttribute(k, v) { e.attrs[k] = v; if (k === 'class') { e.className = v; } }, appendChild(c) { e.children.push(c); },
      addEventListener() {}, set innerHTML(_) { e.children = []; }, replaceChildren() { e.children = []; },
      classList: { toggle() {}, add() {}, remove() {} }, dataset: {},
      getBoundingClientRect: () => (/\bprobe\b/.test(e.className)
        ? { height: e.children.length * 14 + 12 } : { width: e.textContent.length * 6 }),
    };
    return e;
  };
  return { getElementById: make, querySelectorAll: () => [], createElementNS: make, body: make() };
}

test('map has a refresh button that redraws and asks for a fresh snapshot', () => {
  const h = loadPanel('mapPanel');
  h.exports.MapPanel.show({ extensionUri: 'extension' }, snapshot, 1);
  assert.match(h.html(), /id="refresh"/);
  assert.match(h.html(), /type:'refresh'/);
  const before = h.data().length;
  h.send({ type: 'refresh' });
  assert.equal(h.data().length, before + 1);
  assert.deepEqual(h.commands.at(-1), ['pengupool.refresh']);  // reload everything from the backend
  assert.match(h.html(), /fresh = true/);                      // and re-lay out from that snapshot
});

test('dragging a map card onto another groups it there, and onto empty canvas lifts it to the top', () => {
  const h = loadPanel('mapPanel');
  h.exports.MapPanel.show({ extensionUri: 'extension' }, snapshot, 1);
  const script = [...h.html().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const posted = [], on = {};
  const card = (id) => ({ inWrap: true, closest: (sel) => (sel === '.node' ? { dataset: { id } } : null) });
  const canvas = { inWrap: true, closest: () => null };
  const at = { 0: card('a'), 20: card('b'), 40: canvas, 99: null };  // x -> what the pointer is over
  const dom = fakeDom();
  const make = dom.getElementById;
  const wrap = { ...make(), addEventListener: (type, fn) => { on[type] = fn; }, contains: (t) => !!t?.inWrap, setPointerCapture() {} };
  dom.getElementById = (id) => (id === 'wrap' ? wrap : make());
  dom.elementFromPoint = (x) => at[x];
  dom.body.classList = { toggle() {} };
  const sandbox = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), document: dom,
                    window: { addEventListener() {} }, setTimeout() {} };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const drag = (from, to, moved = true) => {
    on.pointerdown({ button: 0, clientX: from, clientY: 0, target: at[from] });
    if (moved) { on.pointermove({ clientX: to, clientY: 0, pointerId: 1 }); }
    on.pointerup({ clientX: to, clientY: 0 });
  };
  const groups = () => posted.filter((m) => m.type === 'group');
  drag(0, 20);
  assert.deepEqual({ ...groups().at(-1) }, { type: 'group', source: 'a', target: 'b' });
  drag(0, 40);
  assert.deepEqual({ ...groups().at(-1) }, { type: 'group', source: 'a', target: '' });
  const before = groups().length;
  drag(0, 0, false);   // a plain click: no move past the threshold, so it selects, not regroups
  drag(0, 0);          // dropped back on itself
  drag(0, 99);         // released outside the map
  assert.equal(groups().length, before);
  h.send({ type: 'group', source: 'a', target: 'b' });
  assert.deepEqual([...h.ctl.at(-1)], ['group', 'a', 'b']);   // the host regroups through ctl, like the list
});

test('map refreshes workflow and context without a topology change', () => {
  const h = loadPanel('mapPanel');
  h.exports.MapPanel.show({ extensionUri: 'extension' }, snapshot, 1);
  const script = [...h.html().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const sandbox = { acquireVsCodeApi: () => ({ postMessage() {} }), document: fakeDom(), window: { addEventListener() {} } };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  vm.runInContext(`
    const card = {grp: {setAttribute() {}}, state: {}, nm: {}, meta: {}, harness: {}, ctx: {}, repo: {}, title: {}, chain: {style: {}}};
    nodeEls.set('one', card);
    restyle({roots:[{id:'one', name:'One', repo:'repo', state:'active', ctx_pct:68,
                    status:'[fix] diagnose ● → verify ○', children:[]}]});
    if(card.chain.textContent !== '[fix] diagnose ● → verify ○') throw Error('missing chain');
    restyle({roots:[{id:'one', name:'One', repo:'repo', state:'active', ctx_pct:2,
                    status:'[fix] diagnose ✓ → verify ●', children:[]}]});
    if(card.chain.textContent !== '[fix] diagnose ✓ → verify ●') throw Error('stale chain');
    if(card.ctx.textContent !== '2%' || card.ctx.className !== 'ctx ctx-low') throw Error('stale context');
    restyle({roots:[{id:'one', name:'One', repo:'repo', state:'active', ctx_pct:45, status:'', children:[]}]});
    if(card.ctx.className !== 'ctx ctx-mid') throw Error('45% should be orange');
    restyle({roots:[{id:'one', name:'One', repo:'repo', state:'active', ctx_pct:60, status:'', children:[]}]});
    if(card.ctx.className !== 'ctx ctx-high') throw Error('60% should be red');
  `, sandbox);
});

const cc = (id, name, children = []) => ({ id, name, harness: 'cc', state: 'active', children });
const pi = (id, name, children = []) => ({ id, name, harness: 'pi', state: 'active', children });
const mixed = {
  topo_hash: 'mix', roots: [cc('c1', 'alpha'), pi('p1', 'beta')], cross: [],
  msgs: [['now', 'alpha', 'alpha', 'to cc', false], ['now', 'beta', 'beta', 'to pi', true]],
};

for (const [name, show] of [
  ['map', (h, snap) => h.exports.MapPanel.show({ extensionUri: 'extension' }, snap, 1)],
  ['log', (h, snap) => h.exports.LogPanel.show(snap, 1)],
]) {
  test(`${name} shows Claude Code | pi tabs only while both harnesses run`, () => {
    const h = loadPanel(name + 'Panel');
    const panel = show(h, { ...mixed, roots: [pi('p1', 'beta')] });
    assert.match(h.html(), /data-harness="cc"[^>]*>Claude Code</);
    assert.match(h.html(), /data-harness="pi"[^>]*>pi</);
    assert.equal(h.tabs().at(-1).shown, false);
    panel.update(mixed);
    assert.equal(h.tabs().at(-1).shown, true);
    assert.equal(h.tabs().at(-1).active, 'cc');
  });

  test(`${name} tab click filters to that harness without a backend round-trip`, () => {
    const h = loadPanel(name + 'Panel');
    show(h, mixed);
    const labels = () => name === 'map'
      ? h.data().at(-1).roots.map((root) => root.name)
      : h.data().at(-1).map((message) => message[3]);
    assert.deepEqual(labels(), name === 'map' ? ['alpha'] : ['to cc']);
    h.send({ type: 'tab', harness: 'pi' });
    assert.equal(h.tabs().at(-1).active, 'pi');
    assert.deepEqual(labels(), name === 'map' ? ['beta'] : ['to pi']);
  });

  test(`${name} defaults to the selected session's harness until a tab is picked`, () => {
    const h = loadPanel(name + 'Panel');
    const panel = show(h, mixed);
    panel.select('p1');
    assert.equal(h.tabs().at(-1).active, 'pi');
    h.send({ type: 'tab', harness: 'cc' });
    panel.select('p1');
    assert.equal(h.tabs().at(-1).active, 'cc');
  });
}

test('map relayouts on a tab switch but not on a status-only tick', () => {
  const h = loadPanel('mapPanel');
  const panel = h.exports.MapPanel.show({ extensionUri: 'extension' }, mixed, 1);
  const hash = () => h.data().at(-1).topo_hash;
  const first = hash();
  panel.update({ ...mixed, roots: mixed.roots.map((root) => ({ ...root, state: 'waiting' })) });
  assert.equal(hash(), first);
  h.send({ type: 'tab', harness: 'pi' });
  assert.notEqual(hash(), first);
});

test('map cards stay compact without a chain and grow with its length', () => {
  const h = loadPanel('mapPanel');
  h.exports.MapPanel.show({ extensionUri: 'extension' }, snapshot, 1);
  const script = [...h.html().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const sandbox = { acquireVsCodeApi: () => ({ postMessage() {} }), document: fakeDom(), window: { addEventListener() {} } };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const size = (status, ctx = 12) => vm.runInContext(
    `cardSize({name:'worker', repo:'repo', ctx_pct:${ctx}, status:${JSON.stringify(status)}, children:[]})`, sandbox);
  const compact = size(''), short = size('[fix] a ●'), long = size('[harness-tabs] ext ● → tui ○ → verify ○ → pr ○ → release ○');
  assert.deepEqual({ ...compact }, { width: 180, height: 3 * 14 + 12 + 2 }, 'state, name and meta lines only (+2px slack)');
  assert.equal(short.width, 260, 'two widths only: a card with a chain is the wide one');
  assert.equal(long.width, 260);
  assert.ok(short.height > compact.height);
  assert.ok(long.height >= short.height, 'a longer chain grows the card down, never wider');
  assert.deepEqual({ ...size('', 100) }, { ...size('', 2) }, 'ctx % changes never resize a card');
});

// dagre stand-in: each node sits where the test says (x, y are centres, as dagre reports them).
function fakeDagre(at) {
  class Graph {
    constructor() { this.n = {}; this.e = []; }
    setGraph() {} setDefaultEdgeLabel() {} graph() { return { width: 400, height: 300 }; }
    setNode(id, size) { this.n[id] = { ...size, ...at[id] }; } node(id) { return this.n[id]; }
    setEdge(a, b) { this.e.push({ v: a, w: b }); } edges() { return this.e; }
    nodes() { return Object.keys(this.n); } edge() { return { points: [] }; }
  }
  return { graphlib: { Graph }, layout() {} };
}

function drawMap(snap, at, width = 2000) {
  const h = loadPanel('mapPanel');
  h.exports.MapPanel.show({ extensionUri: 'extension' }, snapshot, 1);
  const script = [...h.html().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const dom = fakeDom(); const scene = dom.getElementById('scene');
  const wrap = { ...fakeDom().body, clientWidth: width };
  dom.getElementById = (id) => (id === 'scene' ? scene : id === 'wrap' ? wrap : fakeDom().body);
  const sandbox = { acquireVsCodeApi: () => ({ postMessage() {} }), document: dom, window: { addEventListener() {} }, dagre: fakeDagre(at) };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  sandbox.snap = snap;
  vm.runInContext('relayout(snap)', sandbox);
  drawMap.sandbox = sandbox;
  return scene.children;
}

// Every straight run in a path is horizontal or vertical; bends are Q curves.
function rightAngled(d) {
  let x, y;
  for (const [, cmd, args] of d.matchAll(/([MLQ])([^MLQ]*)/g)) {
    const nums = args.trim().split(/[ ,]+/).map(Number);
    const [nx, ny] = nums.slice(-2);
    if (cmd === 'L' && Math.abs(nx - x) > 1e-9 && Math.abs(ny - y) > 1e-9) return false;
    [x, y] = [nx, ny];
  }
  return true;
}

const lead = { ...cc('l', 'lead', [{ ...cc('a', 'api'), label: 'add the refresh endpoint' }, cc('w', 'web')]) };
const at = { l: { x: 200, y: 30 }, a: { x: 100, y: 130 }, w: { x: 300, y: 130 }, p: { x: 380, y: 30 } };

test('map tree edges are right-angled paths with a masked label beside the drop', () => {
  const out = drawMap({ roots: [lead], cross: [] }, at);
  const paths = out.filter((e) => e.className === 'edge');
  assert.equal(paths.length, 2);
  for (const p of paths) assert.ok(rightAngled(p.attrs.d), p.attrs.d);
  const mask = out.find((e) => e.className === 'emask'), text = out.find((e) => e.className === 'elabel');
  assert.ok(mask && text, 'label drawn on a mask');
  assert.ok(Number(mask.attrs.x) >= 100 + 6, 'mask sits 6px beside the drop');
  assert.ok(out.indexOf(mask) > out.indexOf(paths[1]), 'labels are drawn over the edges');
});

test('map lights a tree line green for a message and milky blue for the reply, then lets it fade', () => {
  const now = Date.parse('2026-09-23T12:00:00Z'), ago = (s) => new Date(now - s * 1000).toISOString();
  const msgs = [[ago(10), 'lead', 'api', 'add the endpoint', false], [ago(5), 'api', 'lead', 'done', false],
                [ago(20), 'lead', 'web', 'wire the form', false], [ago(300), 'lead', 'deploy', 'old', false],
                [ago(3), 'web', 'payments', '@ question', false]];
  const snap = { roots: [lead, cc('p', 'payments')], cross: [], msgs };
  const out = drawMap(snap, at);
  drawMap.sandbox.snap = snap;
  vm.runInContext(`restyle(snap, ${now})`, drawMap.sandbox);
  const edges = out.filter((e) => /\bedge\b/.test(e.className));
  assert.equal(edges.length, 2, 'tree lines only; no line for the @ message to an ungrouped session');
  const [toApi, toWeb] = edges;   // tree order: lead>api, lead>web
  assert.match(toApi.className, /hot-up/, 'the latest message on lead–api is the reply');
  assert.match(toWeb.className, /hot-down/);
  vm.runInContext(`restyle(snap, ${now + 120000})`, drawMap.sandbox);
  assert.ok(edges.every((e) => e.className === 'edge'), 'back to plain after the hot window');
});

test('map marks the lead of a tree and dashes ungrouped sessions', () => {
  const out = drawMap({ roots: [lead, cc('p', 'payments')], cross: [] }, at);
  const cards = out.filter((e) => /\bnode\b/.test(e.className));
  const byName = (n) => cards.find((c) => c.attrs['aria-label'] === 'Open ' + n);
  assert.match(byName('payments').className, /\blone\b/);
  assert.doesNotMatch(byName('lead').className, /\blone\b/);
  const chips = (card) => JSON.stringify(card, (k, v) => (k === 'children' || k === 'className' || k === 'textContent' || !k || /^\d+$/.test(k) ? v : undefined));
  assert.match(chips(byName('lead')), /"chip"[^}]*"LEAD"|"LEAD"[^}]*"chip"/);
  assert.doesNotMatch(chips(byName('api')), /LEAD/);
  // nothing grouped: no session is singled out as ungrouped
  const solo = drawMap({ roots: [cc('p', 'payments'), cc('l', 'lead')], cross: [] }, at);
  assert.ok(solo.filter((e) => /\bnode\b/.test(e.className)).every((c) => !/\blone\b/.test(c.className)));
});

test('map options switch direction and spacing, and stay across redraws', () => {
  const pay = cc('p', 'payments');
  const snap = { roots: [lead, pay], cross: [['web', 'payments', 'logout?']] };
  // left-right: tree edges leave the parent's right side and bend in the gap between the columns
  const lr = { l: { x: 60, y: 150 }, a: { x: 300, y: 60 }, w: { x: 300, y: 240 }, p: { x: 540, y: 240 } };
  const h = loadPanel('mapPanel');
  h.exports.MapPanel.show({ extensionUri: 'extension' }, snapshot, 1);
  const script = [...h.html().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  let state = { opts: { dir: 'LR' } };
  const dom = fakeDom(); const scene = dom.getElementById('scene');
  dom.getElementById = (id) => (id === 'scene' ? scene : fakeDom().body);
  const sandbox = { acquireVsCodeApi: () => ({ postMessage() {}, getState: () => state, setState: (s) => { state = s; } }),
    document: dom, window: { addEventListener() {} }, dagre: fakeDagre(lr), snap };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  vm.runInContext('relayout(snap)', sandbox);
  const paths = scene.children.filter((e) => e.className === 'edge');
  assert.equal(paths.length, 2);
  for (const p of paths) assert.ok(rightAngled(p.attrs.d), p.attrs.d);
  assert.match(paths[0].attrs.d, /^M\d+(\.\d+)?,182 /, 'starts on the lead card, at its centre line (12px margin + 20px frame pad)');
  vm.runInContext("setOpt('spacing', 'compact')", sandbox);
  assert.equal(state.opts.spacing, 'compact', 'saved in the webview state');
  assert.equal(state.opts.layout, 'right', 'a left-right map saved before layouts had names stays left-right');
});

const pos = (out, n) => out.find((c) => c.attrs['aria-label'] === 'Open ' + n)
  .attrs.transform.match(/translate\(([-\d.]+),([-\d.]+)\)/).slice(1).map(Number);

const frames = (out) => out.filter((e) => e.className === 'frame').map((f) => ['x', 'y', 'width', 'height'].map((k) => Number(f.attrs[k])));

test('map frames each group and flows ungrouped sessions in a row below them', () => {
  const out = drawMap({ roots: [lead, cc('p', 'payments'), cc('q', 'billing')], cross: [] }, at);
  const [frame, ...more] = frames(out);
  assert.equal(more.length, 0, 'one frame per group');
  const [px, py] = pos(out, 'payments'), [qx, qy] = pos(out, 'billing');
  assert.equal(py, qy, 'one row');
  assert.ok(qx > px, 'left to right');
  assert.ok(py > frame[1] + frame[3], 'below the group');
  assert.ok(out.some((e) => e.className === 'eyebrow' && e.textContent === 'UNGROUPED'));
});

test('map groups share a row while they fit the panel, and wrap when they do not', () => {
  const other = cc('m', 'mono', [cc('k', 'keys')]);
  const wide = frames(drawMap({ roots: [lead, other], cross: [] }, at, 2000));
  assert.equal(wide[1][1], wide[0][1], 'side by side');
  assert.ok(wide[1][0] >= wide[0][0] + wide[0][2] + 40, 'roomy keeps 40px between frames');
  const narrow = frames(drawMap({ roots: [lead, other], cross: [] }, at, 500));
  assert.equal(narrow[1][0], narrow[0][0], 'wrapped under, left-aligned');
  assert.ok(narrow[1][1] >= narrow[0][1] + narrow[0][3] + 40);
});

test('a folded group shows only its lead, as a stack, counting what it hides', () => {
  const waiting = { ...lead, children: [lead.children[0], { ...lead.children[1], state: 'waiting' }] };
  drawMap({ roots: [cc('p', 'payments')], cross: [] }, at);
  const sb = drawMap.sandbox;
  sb.snap = { roots: [waiting], cross: [] };
  vm.runInContext("folded.add('l'); relayout(snap); restyle(snap)", sb);
  const scene = vm.runInContext("document.getElementById('scene')", sb).children;
  const cards = scene.filter((e) => /\bnode\b/.test(e.className));
  assert.deepEqual(cards.map((c) => c.attrs['aria-label']), ['Open lead, Active']);
  assert.ok(cards[0].children.some((e) => e.className === 'box stack'));
  assert.equal(scene.filter((e) => e.className === 'edge').length, 0);
  const fold = vm.runInContext("nodeEls.get('l').fold", sb);
  assert.equal(fold.textContent, '▸ 2');
  assert.match(fold.className, /urgent state-waiting/, 'a waiting session folded away still shows');
  vm.runInContext("folded.clear(); relayout(snap); restyle(snap)", sb);
  assert.equal(vm.runInContext("nodeEls.get('l').fold.textContent", sb), '▾');
});

test('parents side by side in a rank get their own bus lane when their families overlap', () => {
  drawMap({ roots: [lead], cross: [] }, at);
  const bus = vm.runInContext(`buses(geometry({
    a: { x: 100, y: 50, width: 80, height: 40 }, b: { x: 300, y: 50, width: 80, height: 40 },
    a1: { x: 250, y: 200, width: 80, height: 40 }, b1: { x: 150, y: 200, width: 80, height: 40 },
    c: { x: 600, y: 50, width: 80, height: 40 }, c1: { x: 600, y: 200, width: 80, height: 40 } }, true),
    [['a', 'a1'], ['b', 'b1'], ['c', 'c1']])`, drawMap.sandbox);
  assert.equal(bus.a, 82);
  assert.equal(bus.b, 90, 'overlaps a, so one lane out');
  assert.equal(bus.c, 82, 'clear of both, back in the first lane');
});

test('compact spacing is visibly tighter and leaves the chain to the tooltip', () => {
  drawMap({ roots: [lead], cross: [] }, at);
  const sb = drawMap.sandbox;
  const roomy = vm.runInContext("opts.spacing='roomy'; spacing()", sb);
  const compact = vm.runInContext("opts.spacing='compact'; spacing()", sb);
  for (const k of ['sib', 'rank', 'stack', 'gap']) assert.ok(compact[k] * 1.5 <= roomy[k], k);
  assert.equal(compact.pad, 0, 'no frames when compact');
  assert.equal(vm.runInContext("chainOf({ status: 'plan ● → fix ○' })", sb), '');
  assert.equal(vm.runInContext("opts.spacing='roomy'; chainOf({ status: 'plan ● → fix ○' })", sb), 'plan ● → fix ○');
});


test('org chart stacks a family of three or more leaves in a column on a spine', () => {
  const wide = cc('g', 'gateway', ['a', 'b', 'c', 'd'].map((k) => cc(k, 'kid-' + k)));
  const out = drawMap({ roots: [wide], cross: [] }, {});
  const xs = ['a', 'b', 'c', 'd'].map((k) => pos(out, 'kid-' + k)[0]), ys = ['a', 'b', 'c', 'd'].map((k) => pos(out, 'kid-' + k)[1]);
  assert.equal(new Set(xs).size, 1, 'one column');
  assert.ok(ys.every((y, i) => !i || y > ys[i - 1]), 'stacked top to bottom');
  const paths = out.filter((e) => e.className === 'edge');
  assert.equal(paths.length, 4);
  for (const p of paths) assert.ok(rightAngled(p.attrs.d), p.attrs.d);
});

test('compact packs groups closer than roomy, and no group reaches into another family', () => {
  const groups = ['p', 'q', 'r'].map((g) => cc(g, 'lead-' + g, [cc(g + '1', g + '-one'), cc(g + '2', g + '-two')]));
  drawMap({ roots: groups, cross: [] }, {}, 900);
  const sb = drawMap.sandbox;
  sb.snap = { roots: groups, cross: [] };
  const svgOf = (spacing) => { vm.runInContext(`opts.spacing='${spacing}'`, sb);
    const scene = vm.runInContext("document.getElementById('scene')", sb);
    vm.runInContext('relayout(snap)', sb); return scene.children; };
  const area = (out) => { const ps = out.filter((e) => /\bnode\b/.test(e.className)).map((c) => c.attrs.transform.match(/([-\d.]+),([-\d.]+)/).slice(1).map(Number));
    return (Math.max(...ps.map((p) => p[0])) + 180) * (Math.max(...ps.map((p) => p[1])) + 56); };
  assert.ok(area(svgOf('compact')) < area(svgOf('roomy')));
  const blocks = vm.runInContext("['p','q','r'].map(g => rectsOf(LAYOUT.org(visible(snap.roots).roots.find(r => r.id === g), spacing())))", sb);
  const placed = vm.runInContext("pack(['p','q','r'].map(g => LAYOUT.org(visible(snap.roots).roots.find(r => r.id === g), spacing())), 876, 16)", sb);
  const moved = blocks.map((rs, i) => rs.map(([a, b, c, d]) => [a + placed[i][0], b + placed[i][1], c + placed[i][0], d + placed[i][1]]));
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) for (const r of moved[i]) for (const s of moved[j]) {
    const apart = r[2] + 16 <= s[0] || s[2] + 16 <= r[0] || r[3] + 16 <= s[1] || s[3] + 16 <= r[1];
    assert.ok(apart, `group ${i} and ${j} come within 16px`);
  }
});
