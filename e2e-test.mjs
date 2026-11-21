// End-to-end check of index.html in headless Chrome, driven over the DevTools protocol.
// Usage: node e2e-test.mjs        (needs `google-chrome` on PATH, Node 22+)
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const page = 'file://' + join(dirname(fileURLToPath(import.meta.url)), 'index.html');
const tmp = mkdtempSync(join(tmpdir(), 'detektyw-e2e-'));
const KEY = 'detektyw-notatnik.v1';

const note = (id, text) => ({ id, text, pos: null });
const sample = {
  id: 'b1', name: 'Antykwariat',
  nodes: [
    { id: 'p1', type: 'osoba', title: 'Henryk Walczak', x: 60, y: 90, collapsed: false, leads: ['112'],
      notes: [note('t1', 'Właściciel antykwariatu, 61 lat'), note('t2', 'Miał długi u lichwiarza')] },
    { id: 's1', type: 'sprawa', title: 'Zabójstwo w antykwariacie', x: 580, y: 90, collapsed: false, leads: ['104'],
      notes: [note('t3', 'Ciało znalezione 12.03 rano'), note('t4', 'Brak śladów włamania')] },
    { id: 'm1', type: 'miejsce', title: 'Antykwariat, Lipowa 7', x: 1100, y: 90, collapsed: false, leads: ['121'],
      notes: [note('t5', 'Kamera na zapleczu nie działała')] },
    { id: 'p2', type: 'osoba', title: 'Irena Sobczak', x: 60, y: 540, collapsed: false, leads: ['117', '104'],
      notes: [note('t6', 'Wspólniczka, dziedziczy udziały'), note('t7', 'Twierdzi, że była w teatrze')] },
    { id: 'd1', type: 'dowod', title: 'Odcisk palca na kasie', x: 1100, y: 540, collapsed: false, leads: ['130'],
      notes: [note('t8', 'Nie należy do ofiary')] },
  ],
  edges: [
    { id: 'e1', from: 'p1', to: 's1', label: 'ofiara', hypothesis: false, directed: true },
    { id: 'e2', from: 'p2', to: 's1', label: 'podejrzana', hypothesis: true, directed: true },
    { id: 'e3', from: 'm1', to: 's1', label: 'miejsce zbrodni', hypothesis: false, directed: true },
    { id: 'e4', from: 'd1', to: 'm1', label: 'znaleziony w', hypothesis: false, directed: true },
    { id: 'e5', from: 'd1', to: 'p2', label: 'jej odcisk', hypothesis: true, directed: true },
    { id: 'e6', from: 'p1', to: 'p2', label: 'wspólnicy', hypothesis: false, directed: false },
  ],
  leads: {
    104: { comment: 'Przesłuchanie sprzątaczki', done: false },
    112: { comment: 'Wyciąg z konta ofiary', done: false },
    117: { comment: 'Sprawdzić alibi w teatrze', done: false },
    121: { comment: 'Monitoring sąsiedniego sklepu', done: false },
    130: { comment: 'Analiza odcisku w laboratorium', done: true },
  },
};

/* ---------- browser plumbing ---------- */

const PORT = 9333;
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(tmp, 'profile')}`, '--window-size=1500,900', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let msgId = 0;
const pending = new Map(), errors = [];
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id) pending.get(d.id)?.(d);
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise(r => { const i = ++msgId; pending.set(i, d => r(d.result || d)); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
const click = async (x, y, n = 1) => { for (let c = 1; c <= n; c++) { await mouse('mousePressed', x, y, { clickCount: c }); await mouse('mouseReleased', x, y, { clickCount: c }); } };
const rightClick = async (x, y) => { await mouse('mousePressed', x, y, { button: 'right', buttons: 2 }); await mouse('mouseReleased', x, y, { button: 'right' }); };
const midClick = async (x, y) => { await mouse('mousePressed', x, y, { button: 'middle', buttons: 4 }); await mouse('mouseReleased', x, y, { button: 'middle' }); await sleep(400); };
const dragTo = async (x1, y1, x2, y2, extra = {}) => {
  await mouse('mousePressed', x1, y1, extra);
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', x1 + (x2 - x1) * i / 8, y1 + (y2 - y1) * i / 8, { buttons: 1, ...extra });
  await mouse('mouseReleased', x2, y2, extra);
};
const type = t => send('Input.insertText', { text: t });
const key = async k => {
  const vk = { Enter: 13, Escape: 27, Delete: 46 }[k];
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk });
};
const rect = sel => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
const clickOn = async sel => { const r = await rect(sel); await click(r.x, r.y); };
const load = async () => { await send('Page.navigate', { url: page }); await sleep(700); };
const SAVE = 1300;  // autosave runs once a second
// A point with empty board around it, big enough for a new card.
const free = () => ev(`(() => { for (let y = 140; y < 600; y += 20) for (let x = 60; x < 1200; x += 20) {
  const ok = [[-150,-40],[150,-40],[-150,170],[150,170],[0,0]].every(([dx,dy]) => { const el = document.elementFromPoint(x+dx, y+dy); return el && isBackground(el); });
  if (ok) return { x, y }; } })()`);

const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + info}`);

await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: tmp });

/* ---------- storage: first run, autosave, broken data ---------- */

await load();
check('first run: one empty board with a hint', await ev(`store.boards.length === 1 && state.name === 'Sprawa 1' && boardName.value === 'Sprawa 1' && !document.querySelector('#empty-hint').hidden`));
{ const f = await free(); await rightClick(f.x, f.y);
  await clickOn('#typemenu button.osoba'); await type('Jan Testowy'); await key('Enter'); await sleep(SAVE); await load();
  check('autosave: node survives reload', await ev(`state.nodes.length === 1 && state.nodes[0].title === 'Jan Testowy' && document.querySelector('#empty-hint').hidden`)); }
await ev(`localStorage.setItem('${KEY}', '{broken')`); await load();
check('broken data: copy kept, fresh board', await ev(`localStorage.getItem('${KEY}.broken') === '{broken' && state.nodes.length === 0`));
await sleep(SAVE);
await ev(`localStorage.setItem('${KEY}', ${JSON.stringify(JSON.stringify({ current: 'b1', boards: [sample] }))})`); await load();
check('stored board loads', await ev(`state.nodes.length === 5 && document.querySelectorAll('.node').length === 5 && document.querySelectorAll('.sticky').length === 8 && boardName.value === 'Antykwariat'`));

/* ---------- toolbar + help ---------- */

check('toolbar buttons', await ev(`[...document.querySelectorAll('#toolbar button')].map(b => b.id).join()`) === 'boards-btn,zoom-reset,fit,help-btn');
check('icons on the title line', await ev(`(() => { const h = document.querySelector('.node[data-id="p1"]'); const i = h.querySelector('.ticon').getBoundingClientRect(), t = h.querySelector('.title').getBoundingClientRect(); return i.top >= t.top - 2 && i.bottom <= t.bottom + 2 && i.right <= t.left; })()`));
check('no delete button in the header', await ev(`document.querySelectorAll('.node .head button').length === state.nodes.length`));
await clickOn('#help-btn');
check('help opens', await ev(`!help.hidden && document.querySelectorAll('#help-card dt').length >= 10 && !document.querySelector('#help-card').textContent.includes('ierzchołek')`));
await key('Escape'); check('help closes on Esc', await ev(`help.hidden`));

/* ---------- leads ---------- */

const openCount = () => ev(`panelToggle.querySelector('.count').textContent`);
check('panel: 4 open leads', await openCount() === '4');
await clickOn('.node[data-id="p1"] .actions button:nth-child(2)'); await type('121'); await key('Enter'); await key('Enter');
check('lead: existing number is shared', await ev(`byId('p1').leads.includes('121') && Object.keys(state.leads).length === 5 && state.leads['121'].comment === 'Monitoring sąsiedniego sklepu'`));
await clickOn('.node[data-id="p1"] .actions button:nth-child(2)'); await type('245'); await key('Enter'); await type('Billingi telefonu'); await key('Enter');
check('lead: new one created', await ev(`JSON.stringify(state.leads['245'])`) === '{"comment":"Billingi telefonu","done":false}' && await openCount() === '5');
await clickOn('.node[data-id="m1"] .lead[data-lead="121"] input');
check('lead: status shared between cards', await ev(`state.leads['121'].done && document.querySelector('.node[data-id="p1"] .lead[data-lead="121"]').classList.contains('done')`) && await openCount() === '4');
check('panel starts as a bubble', await ev(`panel.classList.contains('collapsed') && panelBody.offsetHeight === 0`));
await clickOn('#panel-toggle');
check('panel expands', await ev(`!panel.classList.contains('collapsed') && panelBody.offsetHeight > 100`));
await clickOn('#panel .pitem[data-lead="121"] input');
check('panel checkbox reopens the lead', await ev(`state.leads['121'].done`) === false);
await clickOn('#panel-toggle');

/* ---------- connections ---------- */

{ const h1 = await rect('.node[data-id="s1"] .handle'), tgt = await rect('.node[data-id="d1"] .head');
  await mouse('mousePressed', h1.x, h1.y); await mouse('mouseMoved', (h1.x + tgt.x) / 2, (h1.y + tgt.y) / 2, { buttons: 1 }); await mouse('mouseMoved', tgt.x, tgt.y, { buttons: 1 });
  const fb = await ev(`(() => { const r = temp.getBoundingClientRect(); return { len: Math.hypot(r.width, r.height), shown: getComputedStyle(document.querySelector('#overlay')).display !== 'none', target: document.querySelector('.node[data-id="d1"]').classList.contains('target'), source: document.querySelector('.node[data-id="s1"]').classList.contains('source') }; })()`);
  check('connect: line, source and target shown while dragging', fb.shown && fb.len > 100 && fb.target && fb.source, JSON.stringify(fb));
  await mouse('mouseReleased', tgt.x, tgt.y); await type('narzędzie zbrodni'); await key('Enter');
  check('connect: directed edge with label', await ev(`(() => { const e = state.edges.at(-1); return e.from === 's1' && e.to === 'd1' && e.label === 'narzędzie zbrodni' && e.directed && !canvas.classList.contains('connecting') && !document.querySelector('.node.target, .node.source'); })()`));
  const sel = `'.edge-label[data-edge-id="' + state.edges.at(-1).id + '"] .ctl '`;
  const markers = () => ev(`document.querySelectorAll('#edges .edge[marker-end]').length`);
  const m0 = await markers();
  await ev(`document.querySelector(${sel} + '[data-act=reverse]').click()`);
  check('edge: reverse swaps ends', await ev(`state.edges.at(-1).from === 'd1' && state.edges.at(-1).to === 's1'`));
  await ev(`document.querySelector(${sel} + '[data-act=directed]').click()`);
  check('edge: arrow can be turned off', await ev(`!state.edges.at(-1).directed`) && await markers() === m0 - 1);
  await ev(`document.querySelector(${sel} + '[data-act=hyp]').click()`);
  check('edge: hypothesis toggle', await ev(`state.edges.at(-1).hypothesis && document.querySelectorAll('#edges .edge.hyp').length === 3`));
  await ev(`document.querySelector(${sel} + '[data-act=del]').click()`);
  check('edge: delete', await ev(`state.edges.length`) === 6); }

{ const a = await rect('.node[data-id="m1"] .body'), b = await rect('.node[data-id="p1"] .head'), x0 = await ev(`byId('m1').x`);
  await dragTo(a.x, a.y, b.x, b.y, { modifiers: 8 }); await type('zna'); await key('Enter');
  check('shift+drag connects without moving the card', await ev(`(() => { const e = state.edges.at(-1); return state.edges.length === 7 && e.from === 'm1' && e.to === 'p1' && e.label === 'zna'; })()`) && await ev(`byId('m1').x`) === x0);
  await ev(`state.edges.pop(); render()`); }

{ const lab = '.edge-label[data-edge-id="e1"]';
  const pos = () => ev(`(() => { const l = document.querySelector('${lab}'); return [parseFloat(l.style.left), parseFloat(l.style.top)]; })()`);
  let r = await rect(lab); await dragTo(r.x, r.y, r.x - 70, r.y + 40);
  const st = await ev(`(() => { const e = state.edges.find(x => x.id === 'e1'); const [p, q] = edgeSegment(e); const l = document.querySelector('${lab}'); const x = parseFloat(l.style.left), y = parseFloat(l.style.top); return { t: e.t, off: Math.abs((q.y - p.y) * (x - p.x) - (q.x - p.x) * (y - p.y)) / Math.hypot(q.x - p.x, q.y - p.y), editing: isEditing() }; })()`);
  check('label: drag slides it along the line', st.t !== undefined && st.t !== 0.5 && st.off < 0.01 && !st.editing, JSON.stringify(st));
  const before = await pos(); await ev(`document.querySelector('${lab} [data-act=reverse]').click()`); const after = await pos();
  check('label: reverse keeps its position', Math.hypot(after[0] - before[0], after[1] - before[1]) < 0.5, JSON.stringify([before, after]));
  r = await rect(lab + ' .text'); await click(r.x, r.y);
  check('label: click starts editing', await ev(`document.activeElement.closest('${lab}') !== null && document.activeElement.isContentEditable`));
  await ev(`focusEnd(document.activeElement)`); await type(' zabójstwa'); await key('Enter');
  check('label: edit committed', await ev(`state.edges.find(x => x.id === 'e1').label`) === 'ofiara zabójstwa'); }

{ const lab = '.edge-label[data-edge-id="e6"]', vis = () => ev(`getComputedStyle(document.querySelector('${lab} .ctl')).visibility`);
  await mouse('mouseMoved', 700, 880); await sleep(900);
  check('label buttons: hidden by default', await vis() === 'hidden');
  let r = await rect(lab); await mouse('mouseMoved', r.x, r.y); await sleep(100);
  const bh = await ev(`document.querySelector('${lab} .ctl button').getBoundingClientRect().height / view.k`);
  check('label buttons: shown on hover, big enough', await vis() === 'visible' && bh >= 30, 'height ' + bh);
  await mouse('mouseMoved', 700, 880); await sleep(350);
  check('label buttons: linger after leaving', await vis() === 'visible');
  await sleep(700);
  check('label buttons: hide after the delay', await vis() === 'hidden');
  r = await rect(lab); await mouse('mouseMoved', r.x, r.y); await sleep(100);
  r = await rect(lab + ' [data-act=hyp]'); await mouse('mouseMoved', r.x, r.y); await click(r.x, r.y); await sleep(100);
  check('label buttons: stay after a click', await vis() === 'visible' && await ev(`state.edges.find(x => x.id === 'e6').hypothesis`));
  await clickOn(lab + ' [data-act=hyp]');
  check('label buttons: second click needs no re-hover', await ev(`state.edges.find(x => x.id === 'e6').hypothesis`) === false);
  await mouse('mouseMoved', 700, 880); await sleep(900); }

/* ---------- cards ---------- */

{ const before = await ev(`[byId('p2').x, byId('p2').y]`), r = await rect('.node[data-id="p2"] .head .type');
  await dragTo(r.x, r.y, r.x + 60, r.y + 40);
  const after = await ev(`[byId('p2').x, byId('p2').y]`);
  check('card: drag by header', after[0] > before[0] && after[1] > before[1], JSON.stringify([before, after]));
  await ev(`byId('p2').x = ${before[0]}; byId('p2').y = ${before[1]}; render()`); }

await ev(`view.k = 0.5; view.x = 250; view.y = 200; applyView()`);
{ let f = await free(); await click(f.x, f.y, 2);
  check('double click on the board does nothing', await ev(`typemenu.hidden`));
  await rightClick(f.x, f.y);
  check('right click on the board: four types and a loose note', await ev(`!typemenu.hidden && typemenu.querySelectorAll('button svg').length === 6 && typemenu.querySelector('button.loose').textContent === 'Notatka' && typemenu.lastChild.textContent === 'Grupa'`));
  await clickOn('#typemenu button.dowod'); await type('Nóż do papieru'); await key('Enter');
  check('new card from the menu', await ev(`state.nodes.at(-1).type === 'dowod' && state.nodes.at(-1).title === 'Nóż do papieru' && !isEditing()`));

  f = await free(); const hd = await rect('.node[data-id="p2"] .handle'), n0 = await ev('state.nodes.length'), e0 = await ev('state.edges.length');
  await dragTo(hd.x, hd.y, f.x, f.y);
  check('drop on empty board: menu and pending line', await ev(`!typemenu.hidden && typemenu.querySelectorAll('button').length === 4 && canvas.classList.contains('pending') && document.querySelector('.node[data-id="p2"]').classList.contains('source')`));
  await clickOn('#typemenu button.miejsce'); await type('Teatr Stary'); await key('Enter');
  check('Enter on the title jumps to the connection label', await ev(`document.activeElement.closest('.edge-label') !== null && document.activeElement.isContentEditable`));
  await type('była w'); await key('Enter');
  check('new card created and linked', await ev(`(() => { const n = state.nodes.at(-1), e = state.edges.at(-1); return state.nodes.length === ${n0 + 1} && state.edges.length === ${e0 + 1} && n.title === 'Teatr Stary' && e.from === 'p2' && e.to === n.id && e.label === 'była w' && !canvas.classList.contains('pending'); })()`));
  f = await free(); const b = await rect('.node[data-id="p2"] .body');
  await dragTo(b.x, b.y, f.x, f.y, { modifiers: 8 }); await key('Escape');
  check('dismissed menu creates nothing', await ev(`typemenu.hidden && state.nodes.length === ${n0 + 1} && !canvas.classList.contains('pending') && !document.querySelector('.node.source')`)); }
await ev(`fitView()`);

{ const r = await rect('.node[data-id="p1"] .title'); await click(r.x, r.y, 2); await type('Henryk W.'); await key('Enter');
  check('title: rename by double click', await ev(`byId('p1').title`) === 'Henryk W.' && await ev(`[...panel.querySelectorAll('.where a')].some(a => a.textContent === 'Henryk W.')`));
  await clickOn('.node[data-id="s1"] .head button');
  check('collapse hides body and notes', await ev(`byId('s1').collapsed && !document.querySelector('.node[data-id="s1"] .body') && !document.querySelector('.sticky[data-node-id="s1"]')`));
  await clickOn('.node[data-id="s1"] .head button'); }

/* ---------- view ---------- */

{ const k0 = await ev('view.k');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: -100 }); await sleep(50);
  const k1 = await ev('view.k');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: 300 }); await sleep(50);
  check('wheel zooms in and out', k1 > k0 && await ev('view.k') < k0);
  await ev(`zoomAt(500, 400, 0.6 / view.k)`);
  const w0 = await ev(`toWorld({ clientX: 300, clientY: 250 })`);
  await midClick(300, 250);
  const c = await ev(`toWorld({ clientX: canvas.getBoundingClientRect().left + canvas.clientWidth / 2, clientY: canvas.getBoundingClientRect().top + canvas.clientHeight / 2 })`);
  check('middle click away from 100%: 100% centred on the click', await ev('view.k') === 1 && Math.hypot(c.x - w0.x, c.y - w0.y) < 0.5);
  await midClick(300, 250);
  const fitted = await ev(`JSON.stringify(view)`); await ev(`fitView()`);
  check('middle click at 100%: fits the board', await ev('view.k') < 1 && await ev(`JSON.stringify(view)`) === fitted);
  const r = await rect('.node[data-id="p1"] .body'), v0 = await ev(`[view.x, view.y, byId('p1').x]`);
  await mouse('mousePressed', r.x, r.y, { button: 'middle', buttons: 4 });
  for (let i = 1; i <= 5; i++) await mouse('mouseMoved', r.x + 20 * i, r.y + 12 * i, { button: 'middle', buttons: 4 });
  await mouse('mouseReleased', r.x + 100, r.y + 60, { button: 'middle' });
  const v1 = await ev(`[view.x, view.y, byId('p1').x]`);
  check('middle drag over a card pans the board', Math.abs(v1[0] - v0[0] - 100) < 0.5 && Math.abs(v1[1] - v0[1] - 60) < 0.5 && v1[2] === v0[2], JSON.stringify([v0, v1]));
  await ev(`fitView()`); }

/* ---------- notes ---------- */

{ await clickOn('.node[data-id="m1"] .actions button'); await type('Tylne drzwi otwarte'); await key('Enter');
  check('note: added from the card', await ev(`byId('m1').notes.at(-1).text`) === 'Tylne drzwi otwarte' && await ev(`!isEditing()`));
  const mid = () => ev(`(() => { const g = stickyEls.get('t1').el.getBoundingClientRect(); return { x: g.left + g.width / 2, y: g.top + g.height / 2 }; })()`);
  let r = await mid(); await dragTo(r.x, r.y, r.x + 150, r.y - 60);
  check('note: drag by its surface, no editing', await ev(`byId('p1').notes[0].pos !== null && !isEditing() && !document.querySelector('.sticky .grip')`));
  r = await mid(); await click(r.x, r.y);
  check('note: click starts editing', await ev(`document.activeElement.dataset.noteId === 't1' && document.activeElement.isContentEditable`));
  await ev(`focusEnd(document.activeElement)`); await type(' !!'); await key('Enter');
  check('note: edit committed', (await ev(`byId('p1').notes[0].text`)).endsWith('!!'));
  await clickOn('.sticky[data-node-id="d1"] .text'); await ev(`getSelection().selectAllChildren(document.activeElement)`); await key('Delete'); await key('Escape');
  check('note: emptied note disappears', await ev(`byId('d1').notes.length === 0 && !document.querySelector('.sticky[data-node-id="d1"]')`)); }

/* ---------- loose notes ---------- */

{ await ev(`view.k = 0.5; view.x = 250; view.y = 200; applyView()`);
  const f = await free(); await rightClick(f.x, f.y); await clickOn('#typemenu button.loose');
  check('loose note: created in edit mode', await ev(`state.notes.length === 1 && document.activeElement.dataset.noteId === state.notes[0].id && document.activeElement.isContentEditable`));
  await type('Kto miał klucz do zaplecza?'); await key('Enter');
  check('loose note: text committed, no tether', await ev(`state.notes[0].text === 'Kto miał klucz do zaplecza?' && !isEditing() && document.querySelectorAll('#edges .tether').length === document.querySelectorAll('.sticky:not(.loose)').length`));
  const p0 = await ev(`[state.notes[0].x, state.notes[0].y]`); let r = await rect('.sticky.loose'); await dragTo(r.x, r.y, r.x + 40, r.y + 30);
  const p1 = await ev(`[state.notes[0].x, state.notes[0].y]`);
  check('loose note: drag moves it', Math.abs(p1[0] - p0[0] - 80) < 1 && Math.abs(p1[1] - p0[1] - 60) < 1 && await ev(`!isEditing()`), JSON.stringify([p0, p1]));
  r = await rect('.sticky.loose'); await click(r.x, r.y);
  check('loose note: click starts editing', await ev(`document.activeElement.closest('.sticky.loose') !== null && document.activeElement.isContentEditable`));
  await key('Escape');
  await ev(`addLooseNote(0, 0)`); await key('Escape');
  check('loose note: empty one disappears', await ev(`state.notes.length === 1 && document.querySelectorAll('.sticky.loose').length === 1`));
  await ev(`fitView()`); }

/* ---------- groups ---------- */

{ await ev(`view.k = 0.4; view.x = 420; view.y = 260; applyView()`);
  const tl = await ev(`(() => { const r = canvas.getBoundingClientRect(); return { x: r.left + view.x + (byId('p1').x - 60) * view.k, y: r.top + view.y + (byId('p1').y - 70) * view.k }; })()`);
  check('group: spot above p1 is empty board', await ev(`isBackground(document.elementFromPoint(${tl.x}, ${tl.y}))`));
  await rightClick(tl.x, tl.y); await ev(`typemenu.lastChild.click()`);
  check('group: created with title in edit mode', await ev(`state.groups.length === 1 && document.activeElement.classList.contains('gtitle')`));
  await type('Sprawa antykwariatu'); await key('Enter');
  check('group: titled, drawn behind cards', await ev(`state.groups[0].title === 'Sprawa antykwariatu' && getComputedStyle(document.querySelector('.group')).zIndex === '0' && document.querySelectorAll('.group .gresize').length === 4`));
  // p1 (and its notes) sits inside the default frame, s1 does not
  const in0 = await ev(`(() => { const g = state.groups[0], c = n => { const b = box(n); return b.x >= g.x && b.x <= g.x + g.w && b.y >= g.y && b.y <= g.y + g.h; }; return [c(byId('p1')), c(byId('s1'))]; })()`);
  check('group: p1 inside, s1 outside', in0[0] && !in0[1], JSON.stringify(in0));
  const b0 = await ev(`[state.groups[0].x, byId('p1').x, byId('s1').x, byId('p1').y]`);
  let r = await rect('.group .gtitle'); await dragTo(r.x, r.y, r.x - 40, r.y - 20);
  const b1 = await ev(`[state.groups[0].x, byId('p1').x, byId('s1').x, byId('p1').y]`);
  check('group: drag carries the cards inside, leaves the rest', Math.abs(b1[0] - b0[0] + 100) < 1 && Math.abs(b1[1] - b0[1] + 100) < 1 && b1[2] === b0[2] && Math.abs(b1[3] - b0[3] + 50) < 1, JSON.stringify([b0, b1]));
  const s0 = await ev(`[state.groups[0].w, state.groups[0].h, byId('p1').x]`);
  r = await rect('.group .gresize.se'); await dragTo(r.x, r.y, r.x + 80, r.y + 40);
  const s1 = await ev(`[state.groups[0].w, state.groups[0].h, byId('p1').x]`);
  check('group: corner resizes without moving cards', Math.abs(s1[0] - s0[0] - 200) < 1 && Math.abs(s1[1] - s0[1] - 100) < 1 && s1[2] === s0[2], JSON.stringify([s0, s1]));
  const w0 = await ev(`[state.groups[0].x, state.groups[0].w]`);
  r = await rect('.group .gresize.nw'); await dragTo(r.x, r.y, r.x - 40, r.y);
  const w1 = await ev(`[state.groups[0].x, state.groups[0].w]`);
  check('group: left corner moves the left edge only', Math.abs(w1[0] - w0[0] + 100) < 1 && Math.abs(w1[1] - w0[1] - 100) < 1, JSON.stringify([w0, w1]));
  // inside of a group still behaves like empty board
  const inner = await ev(`(() => { const r = canvas.getBoundingClientRect(), g = state.groups[0]; return { x: r.left + view.x + (g.x + g.w - 60) * view.k, y: r.top + view.y + (g.y + g.h - 40) * view.k }; })()`);
  check('group: its inside is still empty board', await ev(`isBackground(document.elementFromPoint(${inner.x}, ${inner.y}))`));
  await ev(`addGroup(2000, 2000)`); await key('Escape');
  await ev(`fitView()`);
  r = await ev(`(() => { const b = [...document.querySelectorAll('.group')].at(-1).querySelector('.gbar').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await rightClick(r.x, r.y);
  check('group: right click on header offers delete', await ev(`!typemenu.hidden && typemenu.textContent.startsWith('Usuń grupę')`));
  await clickOn('#typemenu button');
  check('group: deleted, nothing else touched', await ev(`state.groups.length === 1 && state.nodes.length`) === await ev(`state.nodes.length`));
  await ev(`fitView()`); }

await ev(`panel.querySelector('.pitem[data-lead="117"] .pmain').click()`); await sleep(450);
{ const c = await rect('.node[data-id="p2"]'), cc = await rect('#canvas');
  check('panel: click shows the card', Math.abs(c.x - cc.x) < 3 && Math.abs(c.y - cc.y) < 3); }
await ev(`fitView()`); await sleep(100);
{ const r = await rect('.node[data-id="d1"] .head .type'); await rightClick(r.x, r.y);
  check('right click on a card: delete menu', await ev(`!typemenu.hidden && typemenu.textContent === 'Usuń materiał'`));
  await clickOn('#typemenu button');
  check('card deleted with its edges and orphan lead', await ev(`!byId('d1') && !state.edges.some(e => e.from === 'd1' || e.to === 'd1') && !state.leads['130']`)); }

/* ---------- boards ---------- */

const nodeCount = await ev('state.nodes.length');
const menu = async label => { await clickOn('#boards-btn'); await ev(`[...typemenu.querySelectorAll('button')].find(b => b.textContent.startsWith(${JSON.stringify(label)})).click()`); await sleep(150); };
await menu('Nowa plansza');
check('new board: empty, name ready to type', await ev(`store.boards.length === 2 && state.nodes.length === 0 && state.notes.length === 0 && !document.querySelector('#empty-hint').hidden && document.activeElement === boardName && document.querySelectorAll('.node, .sticky, .edge-label').length === 0`) && await openCount() === '0');
await ev(`boardName.select()`); await type('Sprawa druga'); await key('Enter');
check('board renamed', await ev(`state.name === 'Sprawa druga' && document.title.startsWith('Sprawa druga')`));
await menu('Antykwariat');
check('switch back keeps the first board', await ev(`state.name === 'Antykwariat' && state.nodes.length === ${nodeCount} && document.querySelectorAll('.node').length === ${nodeCount}`));

await menu('Eksport do pliku'); await sleep(800);
const exported = readdirSync(tmp).find(f => f.endsWith('.json'));
const exportedBoard = exported && JSON.parse(readFileSync(join(tmp, exported), 'utf8'));
check('export writes the board to a file', exported === 'Antykwariat.json' && exportedBoard.board.nodes.length === nodeCount && exportedBoard.board.notes.length === 1 && exportedBoard.board.groups.length === 1 && exportedBoard.format === 'detektyw-notatnik', String(exported));

const setFile = async path => {
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#import-file' });
  await send('DOM.setFileInputFiles', { nodeId, files: [path] }); await sleep(400);
};
await setFile(join(tmp, exported));
check('import adds the file as a new board', await ev(`store.boards.length === 3 && state.name === 'Antykwariat' && state.id !== 'b1' && state.nodes.length === ${nodeCount} && state.edges.length === store.boards[0].edges.length`));
writeFileSync(join(tmp, 'bad.json'), '{"nodes": 5}'); await setFile(join(tmp, 'bad.json'));
check('import rejects a wrong file', await ev(`store.boards.length === 3 && !statusEl.hidden && statusEl.textContent.includes('nie jest planszą')`));

await ev(`window.__set = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error('quota'); }; state.name = 'Antykwariat 2'`); await sleep(SAVE);
check('failed save is reported', await ev(`!statusEl.hidden && statusEl.textContent.startsWith('Zapis nie działa')`));
await ev(`Storage.prototype.setItem = window.__set; state.name = 'Antykwariat'`); await sleep(SAVE);
check('report clears when saving works again', await ev(`statusEl.hidden`));
await menu('Usuń tę planszę');
check('delete asks for a second click', await ev(`store.boards.length === 3 && !typemenu.hidden && typemenu.textContent.includes('na stałe')`));
await ev(`typemenu.querySelector('button').click()`);
check('board deleted', await ev(`store.boards.length === 2 && state.id === 'b1'`));
await menu('Sprawa druga'); await sleep(SAVE); await load();
check('boards and current one survive reload', await ev(`store.boards.length === 2 && state.name === 'Sprawa druga' && store.boards[0].nodes.length === ${nodeCount} && store.boards[0].nodes.find(n => n.id === 'p1').title === 'Henryk W.' && store.boards[0].notes[0].text === 'Kto miał klucz do zaplecza?' && store.boards[0].groups[0].title === 'Sprawa antykwariatu' && document.querySelectorAll('.group').length === 0`));

check('no JS errors', errors.length === 0, errors.join(' | '));

const failed = results.filter(r => r.startsWith('FAIL'));
console.log(failed.length ? failed.join('\n') : '');
console.log(`${results.length - failed.length}/${results.length} passed`);
ws.close();
await new Promise(r => { chrome.once('exit', r); chrome.kill(); });
// Chrome's helper processes may still be writing the profile; a leftover temp dir is harmless.
try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
process.exit(failed.length ? 1 : 0);
