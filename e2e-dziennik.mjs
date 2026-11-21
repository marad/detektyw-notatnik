// End-to-end check of dziennik.html in headless Chrome, driven over the DevTools protocol.
// Usage: node e2e-dziennik.mjs        (needs `google-chrome` on PATH, Node 22+)
//        PAGE_URL=https://... node e2e-dziennik.mjs    to check a deployed copy
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const page = process.env.PAGE_URL || 'file://' + join(dirname(fileURLToPath(import.meta.url)), 'dziennik.html');
const tmp = mkdtempSync(join(tmpdir(), 'dziennik-e2e-'));
const PORT = 9334;
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(tmp, 'profile')}`, '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' });
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
const clickOn = async sel => {
  const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const type = t => send('Input.insertText', { text: t });
const key = async k => {
  const vk = { Enter: 13, Escape: 27 }[k];
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk });
};
const load = async () => { await send('Page.navigate', { url: page }); await sleep(700); };
const shot = async name => { if (!process.env.SHOTS) return; const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(process.env.SHOTS, name + '.png'), Buffer.from(r.data, 'base64')); };
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + info}`);
const c = expr => ev(`JSON.stringify((c => (${expr}))(store.case))`).then(JSON.parse);
const disabled = sel => ev(`document.querySelector(${JSON.stringify(sel)}).disabled`);
const banner = () => ev(`document.querySelector('#banner').hidden ? '' : document.querySelector('#banner').textContent`);

await send('Page.enable'); await send('Runtime.enable');
await load();

/* ---------- starting a case ---------- */

check('first run: case form is open, nothing behind it', await ev(`!mCase.hidden && document.querySelector('#main').hidden && !document.querySelector('#empty').hidden`));
await clickOn('#m-case .btn.primary');
check('case form needs the numbers from the case intro', await ev(`store.case === null && !mCase.hidden`));
await ev(`(() => { const f = fCase.elements; f.name.value = 'Sprawa testowa'; f.days.value = 2; f.stressLimit.value = 3; f.authority.value = 2; f['skill-s1'].value = 1; f['skill-s5'].value = 2; })()`);
await clickOn('#m-case .btn.primary');
check('case starts: day 1, start hour, team at base', JSON.stringify(await c(`[c.day, c.days, c.time, c.stress, c.stressLimit, c.authority, c.locationId, c.skills.s1, c.skills.s5]`)) === '[1,2,8,0,3,2,"l1",1,2]' && await ev(`mCase.hidden && !document.querySelector('#main').hidden`));
check('display: 08:00, day 1 / 2, stress 0 / 3', await ev(`document.querySelector('#time-big').textContent + '|' + document.querySelector('#day-big').textContent + '|' + document.querySelector('#stress-big').textContent`) === '08:00|1 / 2|0 / 3');
check('track: 16 hour cells, 8 of them overtime', await ev(`document.querySelectorAll('.hour').length === 16 && document.querySelectorAll('.hour.ot').length === 8 && document.querySelectorAll('.hour.done').length === 0`));
check('five places, team marker at base', await ev(`document.querySelectorAll('.loc').length === 5 && document.querySelector('.loc.here').dataset.loc === 'l1' && !!document.querySelector('.loc.here .base')`));

/* ---------- team ---------- */

await clickOn('#add-member');
await ev(`(() => { const f = fMember.elements; f.name.value = 'Anna Testowa'; f.role.value = 'konsultant'; f.ability.value = 'Raz dziennie podgląda kartę.'; f.freq.value = 'day'; f.cost.value = 1; })()`);
await clickOn('#m-member .btn.primary');
check('team member added', await ev(`store.team.length === 1 && store.team[0].role === 'konsultant' && document.querySelector('.member .mname').textContent === 'Anna Testowa'`));

/* ---------- moving, leads, report ---------- */

await clickOn('.loc[data-loc="l2"] button');
check('move costs one hour', JSON.stringify(await c(`[c.time, c.locationId, c.stress]`)) === '[9,"l2",0]' && await ev(`document.querySelector('.loc.here').dataset.loc === 'l2'`));
await clickOn('#lead-no'); await type('#214');
await clickOn('.hbtn[data-hours="3"]');
check('lead spends the hours from the card', JSON.stringify(await c(`[c.time, c.stress]`)) === '[12,0]' && await ev(`store.case.log.at(-1).text === 'Trop #214: 3 godziny' && document.querySelector('#lead-no').value === ''`), await ev(`store.case.log.at(-1).text`));
await clickOn('#report');
check('report: one hour, one authority, once a day', JSON.stringify(await c(`[c.time, c.authority, c.reportToday]`)) === '[13,3,true]' && await disabled('#report'));
check('hour buttons preview the cost', await ev(`[...document.querySelectorAll('.hbtn span')].map(s => s.textContent).join('|')`) === '→ 14:00|→ 15:00|→ 16:00|+1 stresu|+2 stresu');
await clickOn('.hbtn[data-hours="2"]');
await clickOn('.hbtn[data-hours="3"]');
check('overtime: one stress per hour after work', JSON.stringify(await c(`[c.time, c.stress]`)) === '[18,2]' && await ev(`store.case.log.at(-1).kind === 'stress' && store.case.log.at(-1).text.includes('+2 stresu')`) && (await banner()).startsWith('Nadgodziny'));
check('track shows spent overtime', await ev(`document.querySelectorAll('.hour.ot.done').length === 2 && document.querySelectorAll('.hour.done').length === 10`));
await clickOn('#undo');
check('undo restores time and stress', JSON.stringify(await c(`[c.time, c.stress, c.log.length]`)) === '[15,0,4]');
await clickOn('.hbtn[data-hours="1"]');
check('end of working hours is announced', JSON.stringify(await c(`[c.time, c.stress]`)) === '[16,0]' && (await banner()).startsWith('Godziny pracy się skończyły'));
check('move in overtime shows its stress', await ev(`document.querySelector('.loc[data-loc="l3"] button').textContent`) === 'Przejdź · 1 h · +1 stresu');
await clickOn('.loc[data-loc="l3"] button');
check('move in overtime costs stress', JSON.stringify(await c(`[c.time, c.stress, c.locationId]`)) === '[17,1,"l3"]');

/* ---------- abilities and tokens ---------- */

await clickOn('.member [data-use-ability]');
check('ability: marked used, cost paid', JSON.stringify(await c(`[c.authority, Object.keys(c.used).length]`)) === '[2,1]' && await ev(`!document.querySelector('.member [data-use-ability]') && document.querySelector('.member .used').textContent === 'użyta dziś'`));
await clickOn('[data-use="s1"]');
check('skill token spent, button locks at zero', JSON.stringify(await c(`[c.skills.s1]`)) === '[0]' && await disabled('[data-use="s1"]'));
await clickOn('[data-act="auth+"]'); await clickOn('[data-act="auth-"]'); await clickOn('[data-act="auth-"]');
check('authority plus and minus', (await c(`c.authority`)) === 1);

/* ---------- ending days ---------- */

await clickOn('#end-day');
check('end of day: next day, start hour, back at base', JSON.stringify(await c(`[c.day, c.time, c.locationId, c.reportToday, c.stress, c.skills.s1]`)) === '[2,8,"l1",false,1,0]');
check('end of day: daily ability is back, tokens are not', await ev(`!!document.querySelector('.member [data-use-ability]') && !document.querySelector('.member [data-use-ability]').disabled`) && !(await disabled('#report')));
check('last day is labelled', await ev(`document.querySelector('#end-day-sub').textContent`) === 'ostatni dzień sprawy');

/* ---------- stress limit ---------- */

await clickOn('.hbtn[data-hours="5"]'); await clickOn('.hbtn[data-hours="5"]');
check('stress limit ends the investigation', JSON.stringify(await c(`[c.time, c.stress]`)) === '[18,3]' && await ev(`finished()`) === 'stress' && (await banner()).startsWith('Limit stresu') && await ev(`document.querySelector('#banner').classList.contains('end')`));
check('after the limit: no leads, moves, report or new day', await ev(`[...document.querySelectorAll('.hbtn, .loc button, #report, #end-day, [data-use-ability]')].every(b => b.disabled)`));
await shot('stress-limit');
await clickOn('#stress-minus');
check('removing stress reopens the investigation', await ev(`finished()`) === null && !(await disabled('.hbtn[data-hours="1"]')));
await clickOn('#undo'); await clickOn('#undo');
check('undo steps back past the limit', JSON.stringify(await c(`[c.time, c.stress]`)) === '[13,1]');
await ev(`store.case.time = 22; render()`);
check('actions that run past the end of the track are locked', await ev(`[...document.querySelectorAll('.hbtn')].map(b => b.disabled).join()`) === 'false,false,true,true,true');
await ev(`store.case.time = 13; render()`);

/* ---------- persistence ---------- */

const before = await ev(`JSON.stringify(store)`);
await load();
check('state survives reload', await ev(`JSON.stringify(store)`) === before && await ev(`mCase.hidden && document.querySelector('#case-name').value === 'Sprawa testowa'`));

/* ---------- last day ---------- */

await clickOn('#end-day');
check('ending the last day ends the investigation', await ev(`finished()`) === 'days' && (await banner()).startsWith('Ostatni dzień zakończony') && (await c(`c.day`)) === 2 && await disabled('#end-day'));
await clickOn('#undo');

/* ---------- settings ---------- */

await clickOn('#settings-btn');
await ev(`(() => { fSet.elements.workEnd.value = 15; const row = document.querySelector('#set-locations .lrow[data-id="l4"]'); row.querySelector('input').value = 'Komisariat'; document.querySelector('#set-locations .lrow[data-id="l5"] button').click(); })()`);
await clickOn('#m-settings .btn.primary');
check('settings: rules and places change', await ev(`store.rules.workEnd === 15 && store.locations.length === 4 && store.locations[3].name === 'Komisariat' && mSet.hidden && document.querySelectorAll('.loc').length === 4 && document.querySelectorAll('.hour.ot').length === 9`));
check('settings: overtime follows the new end of work', await ev(`overtimeCost(13, 3)`) === 1);
await clickOn('#settings-btn');
await ev(`fSet.elements.workEnd.value = 7`); await clickOn('#m-settings .btn.primary');
check('settings: inconsistent hours are refused', await ev(`!mSet.hidden && !document.querySelector('#set-warn').hidden && store.rules.workEnd === 15`));
await key('Escape');

/* ---------- member edit and delete, new case ---------- */

await ev(`[...document.querySelectorAll('.member .btn')].at(-1).click()`);
await ev(`fMember.elements.name.value = 'Anna T.'`); await clickOn('#m-member .btn.primary');
check('member edited', await ev(`store.team[0].name === 'Anna T.'`));
await clickOn('#new-case');
check('new case warns about losing progress', await ev(`!mCase.hidden && !document.querySelector('#case-warn').hidden`));
await ev(`(() => { const f = fCase.elements; f.name.value = 'Sprawa druga'; f.days.value = 4; f.stressLimit.value = 5; f.authority.value = 0; })()`);
await clickOn('#m-case .btn.primary');
check('new case: fresh progress, team and settings kept', JSON.stringify(await c(`[c.name, c.day, c.days, c.time, c.stress, c.log.length]`)) === '["Sprawa druga",1,4,8,0,0]' && await ev(`store.team.length === 1 && store.rules.workEnd === 15 && store.history.length === 0`) && await disabled('#undo'));
await ev(`[...document.querySelectorAll('.member .btn')].at(-1).click()`);
await clickOn('#member-delete');
check('delete asks for a second click', await ev(`store.team.length === 1 && document.querySelector('#member-delete').textContent === 'Na pewno usunąć?'`));
await clickOn('#member-delete');
check('member deleted', await ev(`store.team.length === 0 && mMember.hidden`));
await shot('fresh');

check('link to the evidence board', await ev(`document.querySelector('header a').getAttribute('href')`) === 'index.html');
check('no JS errors', errors.length === 0, errors.join(' | '));

const failed = results.filter(r => r.startsWith('FAIL'));
if (failed.length) console.log(failed.join('\n'));
console.log(`${results.length - failed.length}/${results.length} passed`);
ws.close();
await new Promise(r => { chrome.once('exit', r); chrome.kill(); });
// Chrome's helper processes may still be writing the profile; a leftover temp dir is harmless.
try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
process.exit(failed.length ? 1 : 0);
