const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('fs');
const URL = process.argv[2] || 'https://localhost:4444/app.html';
const OUT = process.env.OUT || '/tmp/notes-ui';
const PASS = 'Auswahl-Test-Passphrase-1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (cond, label, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${extra !== '' ? ' — ' + extra : ''}`); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--ignore-certificate-errors'] });
  const all = [];
  const mk = async (name, opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true, acceptDownloads: true, colorScheme: 'light', hasTouch: !!opts.touch });
    await ctx.addInitScript(() => localStorage.setItem('notizbuch:debugOverlay', '1'));
    if (process.env.NO_P2P || opts.noP2P) await ctx.addInitScript(() => { RTCPeerConnection.prototype.setRemoteDescription = () => Promise.reject(new Error('WebRTC blockiert (Test)')); });
    const X = { name, ctx, logs: [], dialogs: [] };
    if (opts.blockRelay) await ctx.routeWebSocket(/^wss?:\/\/localhost:4444/, ws => ws.close({ code: 1011, reason: 'Relay blockiert (Test)' }));
    // Nur lesender Testzugang: echte Pointer-Gesten, Geometrie unabhängig prüfen.
    await ctx.route('**/js/app.js', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: await response.text() + '\nwindow.rotationTest = () => ({ frame: selectionFrame(), strokes: _displayStrokes, preview: _selPreview });' });
    });
    X.page = await ctx.newPage();
    X.page.on('console', m => { const t = m.text(); if (!/WebSocket connection|willReadFrequently|Password field|WebRTC blockiert/.test(t)) X.logs.push(`${m.type()}: ${t.slice(0, 220)}`); });
    X.page.on('pageerror', e => X.logs.push('PAGEERROR ' + String(e).slice(0, 300)));
    X.page.on('dialog', d => { X.dialogs.push(`${d.type()}: ${d.message().slice(0, 120)}`); d.dismiss().catch(() => {}); });
    all.push(X);
    return X;
  };
  const ready = p => p.waitForFunction(() => /device: [0-9a-f]/.test(document.getElementById('console')?.innerText || ''), null, { timeout: 25000 });
  const fresh = async X => { await X.page.goto(URL); await X.page.click('#btn-new-start'); await X.page.click('#btn-key-confirmed'); await ready(X.page); };
  const ovlText = p => p.evaluate(() => document.getElementById('console')?.innerText || '');
  const ovl = async p => { const t = await ovlText(p); const m = t.match(/striche: (\d+) \(events: (\d+)\)/); const v = t.match(/ansicht: ([\d.]+) (-?[\d.]+) (-?[\d.]+)/); return { s: m ? Number(m[1]) : -1, e: m ? Number(m[2]) : -1, view: v ? { k: Number(v[1]), x: Number(v[2]), y: Number(v[3]) } : null }; };
  /** Auswahl laut Overlay: { n, kind, handles, multi } */
  const sel = async p => { const m = (await ovlText(p)).match(/auswahl: (\d+)(?: \(([^,]+), (\d+) griffe(, mehrere)?(?:, winkel: -?\d+°)?\))?/); return m ? { n: Number(m[1]), kind: m[2] || '', handles: Number(m[3] || 0), multi: !!m[4] } : { n: -1 }; };
  const cnt = async p => (await ovl(p)).s;
  const box = p => p.evaluate(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height }; });
  /** Weltkoordinate [wx, wy, +px, +py] → Position im Fenster */
  const scr = async (p, pt) => { const b = await box(p); const v = (await ovl(p)).view; return { x: b.x + pt[0] * v.k + v.x + (pt[2] || 0), y: b.y + pt[1] * v.k + v.y + (pt[3] || 0) }; };
  const drag = async (p, a, b, { shift = false, steps = 8, mods = [], hold = null } = {}) => {
    const s = await scr(p, a), e = await scr(p, b);
    await p.mouse.move(s.x, s.y); await p.mouse.down();
    if (shift) await p.keyboard.down('Shift');
    for (let i = 1; i <= steps; i++) await p.mouse.move(s.x + (e.x - s.x) * i / steps, s.y + (e.y - s.y) * i / steps);
    if (hold) await hold();
    await p.mouse.up();
    if (shift) await p.keyboard.up('Shift');
    await sleep(250);
  };
  const tap = async (p, pt, mod = null) => { const s = await scr(p, pt); if (mod) await p.keyboard.down(mod); await p.mouse.click(s.x, s.y); if (mod) await p.keyboard.up(mod); await sleep(250); };
  /** Kräftigster Pixel der Strich-Ebene im Umkreis r (Gerätepixel) einer Weltkoordinate: [r,g,b,a] */
  const ink = async (p, wx, wy, r = 2) => { const v = (await ovl(p)).view; return p.evaluate(([x, y, r]) => { const c = document.getElementById('static-canvas'); const k = c.width / c.getBoundingClientRect().width; const d = c.getContext('2d').getImageData(Math.round(x * k) - r, Math.round(y * k) - r, 2 * r + 1, 2 * r + 1).data; let best = [0, 0, 0, 0]; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > best[3]) best = [d[i], d[i + 1], d[i + 2], d[i + 3]]; return best; }, [wx * v.k + v.x, wy * v.k + v.y, r]); };
  /** Anzahl belegter Pixel im Quadrat ±r (CSS-Pixel) um eine Weltkoordinate */
  const inkCount = async (p, wx, wy, r) => { const v = (await ovl(p)).view; return p.evaluate(([x, y, r]) => { const c = document.getElementById('static-canvas'); const k = c.width / c.getBoundingClientRect().width; const n = Math.round(r * k); const d = c.getContext('2d').getImageData(Math.round(x * k) - n, Math.round(y * k) - n, 2 * n + 1, 2 * n + 1).data; let s = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 60) s++; return s; }, [wx * v.k + v.x, wy * v.k + v.y, r]); };
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const isCol = (px, h, tol = 60) => px[3] > 140 && hex(h).every((c, i) => Math.abs(px[i] - c) <= tol);
  const DARK = '#14171c', RED = '#e03131', YELLOW = '#f2c200';
  const empty = px => px[3] === 0;
  /** Prüft dieselbe Bedingung auf A und B */
  const both = async (label, fn) => { const r = []; for (const X of [A, B]) r.push(await fn(X.page)); ok(r.every(x => x === true), label, r.every(x => x === true) ? '' : `A=${JSON.stringify(r[0])} B=${JSON.stringify(r[1])}`); };
  const probe = (wx, wy, want) => async p => { const px = await ink(p, wx, wy); return (want === null ? empty(px) : isCol(px, want)) || `(${wx},${wy}) ${px.join(',')}`; };
  /** Mehrere Proben [[x, y, soll], …] — true oder die erste Abweichung */
  const probes = list => async p => { for (const [x, y, want] of list) { const r = await probe(x, y, want)(p); if (r !== true) return r; } return true; };
  const count = async (label, want) => { const [a, b] = [await cnt(A.page), await cnt(B.page)]; ok(a === want && b === want, label, `A=${a} B=${b} (soll ${want})`); };
  /** Grobes Raster der Strich-Ebene (welche 10-px-Zellen enthalten Farbe) — zum Vergleich zweier Geräte */
  const sig = p => p.evaluate(() => { const c = document.getElementById('static-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const n = 10; let out = '', filled = 0; for (let y = 0; y < c.height; y += n) { for (let x = 0; x < c.width; x += n) { let sum = 0; for (let j = 0; j < n && y + j < c.height; j++) for (let i = 0; i < n && x + i < c.width; i++) { const o = ((y + j) * c.width + x + i) * 4; if (d[o + 3] > 0) sum += d[o] + d[o + 1] * 3 + d[o + 2] * 7 + 1; } out += sum ? (sum % 97).toString(36).padStart(2, '0') : '..'; if (sum) filled++; } } return { out, filled }; });
  const sameSig = async (label, P = A.page, Q = B.page, min = 10) => { await P.keyboard.press('Escape'); await Q.keyboard.press('Escape'); await P.click('#btn-fit'); await Q.click('#btn-fit'); await sleep(500); const [a, b] = [await sig(P), await sig(Q)]; ok(a.out === b.out && a.filled > min, label, `Zellen mit Farbe: ${a.filled} / ${b.filled}`); return a; };
  const selShown = p => p.evaluate(() => !document.getElementById('selbar').hidden);
  const tool = async (p, t) => { await p.keyboard.press({ select: 'v', shape: 's', pen: 'p', fill: 'f' }[t]); await sleep(120); };
  const pickShape = async (p, type) => { await p.click('[data-tool="shape"]'); await p.click(`#pop-shapes [data-shape="${type}"]`); await sleep(120); };
  const reload = async X => { await X.page.reload(); await ready(X.page).catch(() => {}); };
  const reloadBoth = async () => { await Promise.all([reload(A), reload(B)]); await sleep(7000); };
  const undoKey = async p => { await p.keyboard.press('Control+z'); await sleep(1800); };
  const redoKey = async p => { await p.keyboard.press('Control+Shift+Z'); await sleep(1800); };
  const shot = (p, name) => p.screenshot({ path: `${OUT}/${name}` });
  const noHScroll = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
  const pageNo = p => p.evaluate(() => document.getElementById('page-indicator').textContent.trim());
  const gotoPage = async (p, n) => { for (let i = 0; i < 12; i++) { const m = (await pageNo(p)).match(/^(\d+) \/ (\d+)/); if (!m || Number(m[1]) === n) break; await p.click(Number(m[1]) < n ? '#btn-next' : '#btn-prev'); await sleep(700); } await sleep(500); };
  /** Neue Seite auf A anlegen, B geht mit */
  const newPage = async n => { await A.page.click('#btn-add-page'); await sleep(2500); await gotoPage(B.page, n); const [pa, pb] = [await pageNo(A.page), await pageNo(B.page)]; ok(pa === pb && pa.startsWith(n + ' /'), `Seite ${n} auf beiden`, `A=${pa} B=${pb}`); };
  /** Auswahlrechteck aufziehen (beginnt auf leerer Fläche) */
  const marquee = (p, a, b, opts) => drag(p, a, b, opts);
  const toastText = p => p.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent).join(' | '));

  // ── Aufbau: zwei Geräte mit demselben Schlüssel ─────────────────────────
  const A = await mk('A'), B = await mk('B');
  await fresh(A); await sleep(3000);
  const keyHex = await A.page.evaluate(() => JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw')).map(b => b.toString(16).padStart(2, '0')).join(''));
  await B.page.goto(URL + '#' + keyHex); await ready(B.page).catch(() => {});
  await sleep(8000);
  const a = A.page, b = B.page;
  if (process.env.NO_P2P) { const p2p = /↳[^;]*connected/.test(await ovlText(a)); ok(!p2p, 'ohne P2P (nur Relay)'); }
  ok(/rotate-v50/.test(await ovlText(a)), 'Version rotate-v50');
  ok(await a.evaluate(() => document.querySelectorAll('canvas')[2]?.id === 'active-canvas'), 'canvas[2] ist die aktive Zeichenfläche');
  ok((await sel(a)).n === 0, 'Overlay-Zeile „auswahl: 0“ ohne Auswahl', JSON.stringify(await sel(a)));


  const rotate=async (angle)=>{
    const v=(await ovl(a)).view,r=50+43/v.k;
    await drag(a,[400,300-r],[400+r*Math.sin(angle*Math.PI/180),300-r*Math.cos(angle*Math.PI/180)],{steps:20});
    await sleep(2200);
  };
  const rect=angle=>{
    const t=angle*Math.PI/180;
    return probes([... [[-100,0],[100,0],[0,-50],[0,50]].map(([x,y])=>[400+x*Math.cos(t)-y*Math.sin(t),300+x*Math.sin(t)+y*Math.cos(t),DARK]),[400,300,null]]);
  };
  await pickShape(a,'rect'); await drag(a,[300,250],[500,350]); await sleep(2200);
  await tool(a,'select'); await tap(a,[300,300]);
  await rotate(90); await both('90 Grad A/B',rect(90));
  await undoKey(a); await both('Undo Rotation',rect(0));
  await redoKey(a); await both('Redo Rotation',rect(90));
  await undoKey(a); await rotate(45); await both('45 Grad A/B',rect(45));
  await shot(a,'drehen-rechteck-45.png'); await shot(a,'drehen-griff-winkel.png');
  await reloadBoth(); await both('45 Grad Reload',rect(45));
  await tool(a,'select'); await tap(a,[400-100/Math.sqrt(2),300-100/Math.sqrt(2)]);
  await a.click('#btn-sel-proportional');
  ok(await a.locator('#btn-sel-proportional').getAttribute('aria-pressed')==='true','Proportional aktiv');
  await shot(a,'proportional-leiste.png'); await a.click('#btn-sel-proportional');
  await pickShape(a,'ellipse'); await drag(a,[650,250],[810,350]);
  await tool(a,'pen'); await drag(a,[650,450],[810,500]);
  await tool(a,'select'); await a.keyboard.press('Control+a'); await sleep(300);
  ok((await sel(a)).n===3,'Gemischte Gruppe');
  const v=(await ovl(a)).view,top=300-150/Math.sqrt(2),left=400-150/Math.sqrt(2);
  const cx=(left+810)/2,cy=(top+500)/2,r=cy-top+43/v.k;
  await drag(a,[cx,cy-r],[cx+r,cy],{steps:20}); await sleep(2200);
  await shot(a,'drehen-gruppe.png'); await sameSig('Gruppe konvergent');
  await undoKey(a); await sameSig('Gruppe Undo');
  await redoKey(a); await sameSig('Gruppe Redo');
  await reloadBoth(); await sameSig('Gruppe Reload');
  await a.emulateMedia({colorScheme:'dark'}); await shot(a,'drehen-dark.png');
  await a.setViewportSize({width:360,height:780}); await sleep(400);
  ok(await noHScroll(a),'360 ohne Scroll'); await shot(a,'drehen-360.png');
  await a.setViewportSize({width:1400,height:900});
  await a.keyboard.press('Escape'); await sleep(1500);
  await a.click('#btn-notebooks'); await sleep(300); await a.click('#btn-settings'); await sleep(300); await a.click('#set-tab-data'); await sleep(300);
  await a.click('#btn-export-enc'); await a.waitForSelector('#backup-export-modal:not(.hidden)');
  await a.fill('#export-pass', PASS); await a.fill('#export-pass2', PASS);
  const [bk] = await Promise.all([a.waitForEvent('download', { timeout: 30000 }), a.click('#export-ok')]);
  const BK = `${OUT}/drehen-backup.enc`; await bk.saveAs(BK); await sleep(500);
  for (let i = 0; i < 4; i++) { await a.keyboard.press('Escape'); await sleep(200); }
  const C = await mk('C', { blockRelay: true, noP2P: true }); const c = C.page;
  await c.goto(URL); await c.waitForSelector('#firststart-modal:not(.hidden)');
  const [chooser] = await Promise.all([c.waitForEvent('filechooser', { timeout: 10000 }), c.click('#btn-restore-backup')]); await chooser.setFiles(BK);
  await c.waitForSelector('#prompt-modal:not(.hidden)', { timeout: 8000 }).catch(() => {});
  await c.fill('#prompt-input', PASS); await c.keyboard.press('Enter');
  await c.waitForFunction(h => localStorage.getItem('notizbuch:masterKeyHash') === h, await a.evaluate(() => localStorage.getItem('notizbuch:masterKeyHash')), { timeout: 20000 }).catch(() => {});
  await ready(c).catch(() => {}); await sleep(3000);

  ok(await cnt(c)===3,'Backup: drei rotierte Objekte');
  await sameSig('Backup: identische Pixel',a,c);
  await tool(a,'select'); await a.keyboard.press('Control+a'); await sleep(300);
  await a.keyboard.press('Delete'); await sleep(2200); await count('Gruppe löschen',0);
  await undoKey(a); await count('Gruppenlöschen ein Undo',3);
  await sameSig('Wiederherstellen konvergent');
  await newPage(2);
  const lv=(await ovl(a)).view;
  const lp=[(400-lv.x)/lv.k,(300-lv.y)/lv.k], lq=[lp[0]+150/lv.k,lp[1]+50/lv.k];
  await pickShape(a,'line'); await drag(a,lp,lq); await sleep(2200);
  await tool(a,'select'); await tap(a,[(lp[0]+lq[0])/2,(lp[1]+lq[1])/2]);
  ok((await sel(a)).handles===2,'Linie behält zwei Endpunkt-Griffe',JSON.stringify(await sel(a)));
  // Lokale Achsen statt AABB: 30°-Rechteck, fester Gegenpunkt, keine Scherung.
  await newPage(3);
  await a.click('#btn-fit'); await b.click('#btn-fit'); await sleep(300);
  await pickShape(a,'rect'); await drag(a,[300,250],[500,350]);
  await tool(a,'select'); await a.keyboard.press('Control+a'); await sleep(300);

  const read = p => p.evaluate(() => window.rotationTest());
  const point = (f,x,y) => {
    const m=f.basis || [1,0,0,1,0,0];
    return {x:m[0]*x+m[2]*y,y:m[1]*x+m[3]*y};
  };
  const handle = async (p,fx,fy) => {
    const {frame:f}=await read(p),v=(await ovl(p)).view,bb=await box(p);
    const q=point(f,f.x0+(f.x1-f.x0)*fx,f.y0+(f.y1-f.y0)*fy);
    return {x:bb.x+q.x+(f.basis?v.x:0),y:bb.y+q.y+(f.basis?v.y:0)};
  };
  const matrix = async p => (await read(p)).strokes[0].matrix;
  const orthogonal = m => Math.abs(m[0]*m[2]+m[1]*m[3]) < 1e-4;
  const ratio = m => m.length===4 ? Math.abs(m[0]/m[1]) : Math.hypot(m[0],m[1])/Math.hypot(m[2],m[3]);
  const turn = async (p, degrees) => {
    const f=(await read(p)).frame,v=(await ovl(p)).view,bb=await box(p);
    const q=point(f,(f.x0+f.x1)/2,f.y0-36),c=point(f,(f.x0+f.x1)/2,(f.y0+f.y1)/2);
    const ox=bb.x+(f.basis?v.x:0),oy=bb.y+(f.basis?v.y:0),t=degrees*Math.PI/180,dx=q.x-c.x,dy=q.y-c.y;
    await p.mouse.move(q.x+ox,q.y+oy); await p.mouse.down();
    await p.mouse.move(c.x+dx*Math.cos(t)-dy*Math.sin(t)+ox,c.y+dx*Math.sin(t)+dy*Math.cos(t)+oy,{steps:20});
    await p.mouse.up(); await sleep(2200);
  };
  await turn(a,30);
  const start=await handle(a,1,1), fixed=await handle(a,0,0);
  await a.mouse.move(start.x,start.y); await a.mouse.down();
  await a.mouse.move(start.x+70,start.y+15,{steps:10}); await a.mouse.up(); await sleep(2200);
  const fixedAfter=await handle(a,0,0);
  ok(Math.hypot(fixed.x-fixedAfter.x,fixed.y-fixedAfter.y)<2,'30° Resize: Gegenpunkt fest');
  ok(orthogonal(await matrix(a)),'30° Resize: rechte Winkel bleiben erhalten');
  await shot(a,'drehen-rechteck-30-resize.png');
  await undoKey(a);
  // Modifier erst während der Geste drücken und wieder lösen; Vorschau lesen.
  for (const modifier of ['Shift','Control']) {
    const s=await handle(a,1,1);
    await a.mouse.move(s.x,s.y); await a.mouse.down();
    await a.mouse.move(s.x+80,s.y+5,{steps:6});
    const free=(await read(a)).preview.g;
    await a.keyboard.down(modifier); await a.mouse.move(s.x+81,s.y+5);
    const locked=(await read(a)).preview.g;
    await a.keyboard.up(modifier); await a.mouse.move(s.x+82,s.y+5);
    const released=(await read(a)).preview.g;
    ok(Math.abs(ratio(locked)-1)<0.001,modifier+' late press: proportional');
    ok(Math.abs(ratio(free)-1)>0.03 && Math.abs(ratio(released)-1)>0.03,modifier+' release: frei');
    await a.mouse.up(); await undoKey(a);
  }
  // Rotation eines Stiftstrichs und einer Ellipse, jeweils ein Undo.
  for (const kind of ['ellipse','pen']) {
    await a.keyboard.press('Escape');
    if(kind==='ellipse') await pickShape(a,kind); else await tool(a,'pen');
    await drag(a,[650,250],[810,350]); await tool(a,'select');
    await tap(a,kind==='ellipse'?[650,300]:[730,300]);
    const before=JSON.stringify((await read(a)).strokes);
    const f=(await read(a)).frame,v=(await ovl(a)).view,bb=await box(a);
    const q=point(f,(f.x0+f.x1)/2,f.y0-36),c=point(f,(f.x0+f.x1)/2,(f.y0+f.y1)/2);
    const ox=bb.x+(f.basis?v.x:0),oy=bb.y+(f.basis?v.y:0);
    await a.mouse.move(q.x+ox,q.y+oy); await a.mouse.down();
    const theta=Math.PI/6,dx=q.x-c.x,dy=q.y-c.y;
    await a.mouse.move(c.x+dx*Math.cos(theta)-dy*Math.sin(theta)+ox,c.y+dx*Math.sin(theta)+dy*Math.cos(theta)+oy,{steps:15});
    await a.mouse.up(); await sleep(2200);
    ok(JSON.stringify((await read(a)).strokes)!==before,kind+' drehen 30°');
    await shot(a,'drehen-'+kind+'.png');
    await undoKey(a); ok(JSON.stringify((await read(a)).strokes)===before,kind+' Rotation ein Undo');
    await redoKey(a);
  }
  await a.keyboard.press('Control+a'); await sleep(300);
  ok((await sel(a)).handles===4,'Nicht90-Gruppe: nur Eckgriffe');
  const groupBefore=JSON.stringify((await read(a)).strokes);
  const gs=await handle(a,1,1);
  await a.mouse.move(gs.x,gs.y); await a.mouse.down(); await a.mouse.move(gs.x+45,gs.y+5,{steps:10});
  ok(Math.abs(ratio((await read(a)).preview.g)-1)<0.001,'Nicht90-Gruppe zwangsproportional');
  await a.mouse.up(); await sleep(2200); await undoKey(a);
  ok(JSON.stringify((await read(a)).strokes)===groupBefore,'Nicht90-Gruppe Resize ein Undo');
  await sameSig('Nicht90-Gruppe Resize Undo konvergent');
  await tool(a,'fill'); await tap(a,[400,300]); await sleep(2200);
  ok((await read(a)).strokes.some(s=>s.tool==='fill'),'Gedrehtes Rechteck füllen');
  await tool(a,'select'); await tap(a,[400,300]);
  const fillBefore=JSON.stringify((await read(a)).strokes.find(s=>s.tool==='fill'));
  await turn(a,30);
  ok(JSON.stringify((await read(a)).strokes.find(s=>s.tool==='fill'))!==fillBefore,'Füllfläche drehen');
  await shot(a,'drehen-fuellflaeche.png');
  await undoKey(a);
  ok(JSON.stringify((await read(a)).strokes.find(s=>s.tool==='fill'))===fillBefore,'Füllfläche Rotation ein Undo');
  await a.keyboard.press('Escape'); await tap(a,[400-86.6,250]);
  await a.click('#btn-sel-duplicate'); await sleep(2200);
  const copies=(await read(a)).strokes.filter(s=>s.tool==='shape' && s.shape.type==='rect');
  ok(copies.length===2 && copies.every(s=>s.matrix?.length===6),'Duplikat behält affine Matrix');
  await reloadBoth(); await sameSig('Duplikat Matrix Reload konvergent');
  ok((await read(a)).strokes.filter(s=>s.tool==='shape' && s.shape.type==='rect').every(s=>s.matrix?.length===6),'Duplikat Matrix nach Reload');
  await newPage(4); await a.click('#btn-fit'); await b.click('#btn-fit');
  await pickShape(a,'rect'); await drag(a,[300,250],[500,350]); await sleep(2200);
  await tool(a,'select'); await a.keyboard.press('Control+a');
  await tool(b,'select'); await b.keyboard.press('Control+a');
  await Promise.all([turn(a,30),drag(b,[300,300],[330,320],{steps:20})]);
  await sleep(2500);
  await sameSig('Gleichzeitig Drehen/Verschieben konvergiert');
  await reloadBoth(); await sameSig('Gleichzeitig Drehen/Verschieben Reload');
  // Unabhängiges Touch-Gerät: CDP statt synthetischer PointerEvents.
  const T = await mk('Touch', { touch: true, blockRelay: true, noP2P: true });
  await fresh(T); const t = T.page;
  await pickShape(t,'rect'); await drag(t,[300,250],[500,350]);
  await tool(t,'select'); await t.keyboard.press('Control+a'); await sleep(300);
  const cdp = await T.ctx.newCDPSession(t);
  const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x:p.x, y:p.y, id:1, radiusX:2, radiusY:2, force:1 }] : [] });
  const lock = t.locator('#btn-sel-proportional');
  await lock.tap();
  ok(await lock.getAttribute('aria-pressed')==='true','Touch: Proportional eingeschaltet');
  await sleep(500); await reload(T);
  await tool(t,'select'); await t.keyboard.press('Control+a'); await sleep(300);
  ok(await lock.getAttribute('aria-pressed')==='true','Touch: Proportional bleibt nach device-local Reload');
  ok(await a.locator('#btn-sel-proportional').getAttribute('aria-pressed')!=='true','Proportional nicht auf anderes Gerät übertragen');
  for (const locked of [true,false]) {
    if (!locked) await lock.tap();
    const s=await handle(t,1,1);
    await touch('touchStart',s);
    for(let i=1;i<=10;i++) { await touch('touchMove',{x:s.x+80*i/10,y:s.y+5*i/10}); await sleep(20); }
    const g=(await read(t)).preview?.g;
    ok(!!g && (locked ? Math.abs(ratio(g)-1)<0.001 : Math.abs(ratio(g)-1)>0.03),`CDP Touch Resize ${locked?'proportional':'frei'}`,JSON.stringify(g));
    await touch('touchEnd'); await sleep(500);
    const shape=(await read(t)).strokes[0].shape;
    const committedRatio=Math.abs((shape.x2-shape.x1)/(shape.y2-shape.y1))/2;
    ok(locked ? Math.abs(committedRatio-1)<0.001 : Math.abs(committedRatio-1)>0.03,`Touch Commit ${locked?'proportional':'frei'}`,committedRatio);
    await undoKey(t);
  }
  await sleep(500); await reload(T); await tool(t,'select'); await t.keyboard.press('Control+a'); await sleep(300);
  ok(await lock.getAttribute('aria-pressed')==='false','Touch: ausgeschaltete Sperre bleibt nach Reload');

  // Jede Form einzeln: Richtung aus Pixel-Kovarianz, nicht nur „Farbe vorhanden“.
  // Papier/Raster sind hell und zählen nicht; die lange Achse muss um 30° kippen.
  const rasterAngle = async source => t.evaluate(async src => {
    let c;
    if(src) { const img=new Image(); img.src=src; await img.decode(); c=document.createElement('canvas'); c.width=img.width; c.height=img.height; c.getContext('2d').drawImage(img,0,0); }
    else c=document.querySelector('#pages-grid .thumb.current canvas');
    if(!c) return null;
    const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let n=0,x=0,y=0,xx=0,yy=0,xy=0;
    for(let j=0;j<c.height;j++) for(let i=0;i<c.width;i++) { const k=(j*c.width+i)*4; if(d[k+3]>140 && d[k]<90 && d[k+1]<90 && d[k+2]<90) { n++; x+=i; y+=j; xx+=i*i; yy+=j*j; xy+=i*j; } }
    return {n,angle:Math.atan2(2*(xy-x*y/n),xx-x*x/n-yy+y*y/n)*90/Math.PI};
  },source);
  const download = async (btn,file) => { await t.click('#btn-page-menu'); const [d]=await Promise.all([t.waitForEvent('download'),t.click(btn)]); await d.saveAs(file); return fs.readFileSync(file); };
  for(const kind of ['rect','ellipse']) {
    if(kind==='ellipse') { await t.keyboard.press('Escape'); await t.click('#btn-add-page'); await sleep(500); await t.click('#btn-fit'); await pickShape(t,kind); await drag(t,[300,250],[500,350]); await tool(t,'select'); await t.keyboard.press('Control+a'); await sleep(300); }
    await turn(t,30); await t.keyboard.press('Escape'); await sleep(1500); await reload(T);
    await t.click('#btn-page-overview'); await sleep(2500);
    const thumb=await rasterAngle(null);
    ok(thumb?.n>20 && Math.abs(thumb.angle-30)<5,kind+' Thumbnail: gedrehte lange Achse',JSON.stringify(thumb));
    await t.keyboard.press('Escape');
    const png=await download('#btn-menu-export-png',`${OUT}/drehen-${kind}-export.png`);
    const pngStats=await rasterAngle('data:image/png;base64,'+png.toString('base64'));
    ok(pngStats?.n>200 && Math.abs(pngStats.angle-30)<3,kind+' PNG: gedrehte lange Achse',JSON.stringify(pngStats));
    const svg=(await download('#btn-menu-export-svg',`${OUT}/drehen-${kind}-export.svg`)).toString();
    ok(svg.includes('<'+kind+' ') && /matrix\(/.test(svg),kind+' SVG: Vektorform mit Matrix');
    const svgStats=await rasterAngle('data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'));
    ok(svgStats?.n>200 && Math.abs(svgStats.angle-30)<3,kind+' SVG gerastert: gedrehte lange Achse',JSON.stringify(svgStats));
  }

  await newPage(5); await a.click('#btn-fit'); await tool(a,'pen');
  for(let i=0;i<200;i++) {
    const x=100+(i%20)*35,y=150+Math.floor(i/20)*35;
    const s=await scr(a,[x,y]),e=await scr(a,[x+15,y+10]);
    await a.mouse.move(s.x,s.y); await a.mouse.down(); await a.mouse.move(e.x,e.y); await a.mouse.up();
  }
  for(let i=0;i<40 && await cnt(b)<200;i++) await sleep(500);
  await count('Rotation Performance: 200 Objekte auf beiden',200);
  await tool(a,'select'); await a.keyboard.press('Control+a'); await sleep(400);
  ok((await sel(a)).n===200,'Rotation Performance: alle 200 ausgewählt');
  const perfBefore=JSON.stringify((await read(a)).strokes);
  await turn(a,30);
  const zeit=((await ovlText(a)).match(/auswahl-zeit: (.*)/)||[])[1]||'';
  console.log('ZEIT 200 Objekte Rotation: '+zeit);
  const num=re=>Number((zeit.match(re)||[])[1]);
  ok(/^200 objekte/.test(zeit) && num(/zug ([\d.]+) ms/)<4 && num(/bild ([\d.]+) ms/)<50 && num(/loslassen ([\d.]+) ms/)<500,'200 Rotation: Move <4 ms, Frame <50 ms, Release <500 ms',zeit);
  ok(JSON.stringify((await read(a)).strokes)!==perfBefore,'200 Rotation ändert Geometrie');
  await sameSig('200 Rotation konvergent'); await undoKey(a);
  ok(JSON.stringify((await read(a)).strokes)===perfBefore,'200 Rotation ein Undo');
  for(const X of all) ok(!X.logs.some(l=>l.startsWith('PAGEERROR')),X.name+': keine JS-Fehler');
  await browser.close(); console.log(fails?'ERGEBNIS: '+fails+' FEHLER':'ERGEBNIS: ALLES OK');process.exitCode=fails?1:0;
})().catch(e=>{console.error(e);process.exit(1)});
