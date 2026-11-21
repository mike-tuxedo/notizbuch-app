// Test Auswahl (Endpunkt-Griffe + Mehrfachauswahl): node select.cjs <URL>
// Zwei isolierte Kontexte im Geräte-Sync (NO_P2P=1 blockiert WebRTC — der Relay-Live-Weg muss reichen),
// dazu je ein Kontext für Touch (über CDP) und für die eingespielte Sicherung.
// Prüft: Endpunkt-Griffe für Linie/Pfeil (ziehen, umklappen, senkrecht, verschieben, Strg+Z/Redo-Kette),
// gleichzeitiges Endpunkt-Ziehen und Verschieben, kleine Objekte (nur Eckgriffe), Auswahlrechteck,
// Umschalt+Klick, Strg+A, Umschalter „Mehrere“, Gruppe verschieben/skalieren/färben/füllen/duplizieren/
// löschen mit je EINEM Rückgängig-Schritt, Löschen durch das andere Gerät, gemischte Gruppe, 200 Objekte
// ziehen (Zeitmessung), Sicherung, 360 px.
// Koordinaten im Test sind Weltkoordinaten; die Ansicht steht in der Overlay-Zeile 'ansicht: scale x y',
// die Auswahl in 'auswahl: N (art, G griffe)'.
// Endet mit 'ERGEBNIS: ALLES OK' (Exit 0) oder 'ERGEBNIS: n FEHLER' (Exit 1).
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
  const sel = async p => { const m = (await ovlText(p)).match(/auswahl: (\d+)(?: \(([^,]+), (\d+) griffe(, mehrere)?\))?/); return m ? { n: Number(m[1]), kind: m[2] || '', handles: Number(m[3] || 0), multi: !!m[4] } : { n: -1 }; };
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
  ok(/select-v49/.test(await ovlText(a)), 'Version select-v49');
  ok(await a.evaluate(() => document.querySelectorAll('canvas')[2]?.id === 'active-canvas'), 'canvas[2] ist die aktive Zeichenfläche');
  ok((await sel(a)).n === 0, 'Overlay-Zeile „auswahl: 0“ ohne Auswahl', JSON.stringify(await sel(a)));

  // ── 1. Linie und Pfeil: Endpunkt-Griffe ─────────────────────────────────
  await pickShape(a, 'line'); await drag(a, [100, 100], [300, 200]);
  await pickShape(a, 'arrow'); await drag(a, [700, 100], [900, 200]);
  await sleep(2500);
  await count('1 Linie und Pfeil auf A und B', 2);
  await tool(a, 'select'); await tap(a, [800, 150]);
  let s = await sel(a);
  ok(s.n === 1 && s.kind === 'pfeil' && s.handles === 2, '1 Pfeil gewählt: 2 Griffe', JSON.stringify(s));
  await tap(a, [200, 150]);
  s = await sel(a);
  ok(s.n === 1 && s.kind === 'linie' && s.handles === 2 && await selShown(a), '1 Linie gewählt: 2 Griffe, Leiste sichtbar', JSON.stringify(s));
  await shot(a, 'auswahl-linie-endpunkte.png');
  // Zustände der Linie: je eine Probe, die nur in diesem Zustand auf der Linie liegt
  const P = [[200, 150], [200, 250], [400, 250], [300, 250], [450, 300], [550, 295]];
  const lineState = k => probes(P.map(([x, y], i) => [x, y, i === k ? DARK : null]));
  await both('1 Ausgangslage', lineState(0));
  // Endpunkt 2 ziehen: (300,200) → (300,400)
  await drag(a, [300, 200], [300, 400]); await sleep(2500);
  await both('1 Endpunkt gezogen: neuer Verlauf, alter Bereich leer', lineState(1));
  await both('1 alter Endpunkt-Bereich leer, anderer Endpunkt unverändert', probes([[300, 200, null], [290, 195, null], [103, 104.5, DARK], [90, 85, null]]));
  ok((await sel(a)).kind === 'linie' && (await sel(a)).handles === 2, '1 Linie bleibt gewählt');
  // Zur Gegendiagonale umklappen: Endpunkt 1 (100,100) → (500,100)
  await drag(a, [100, 100], [500, 100]); await sleep(2500);
  await both('1 zur Gegendiagonale umgeklappt', lineState(2));
  await both('1 umgeklappt: fester Endpunkt (300,400) unverändert', probes([[302, 397, DARK], [100, 100, null]]));
  // Exakt senkrecht: Umschalt rastet auf 90°
  await drag(a, [500, 100], [310, 90], { shift: true }); await sleep(2500);
  await both('1 exakt senkrecht (Umschalt rastet)', lineState(3));
  await both('1 senkrecht: oben und unten genau über x=300 (links/rechts daneben leer)', async p => { for (const y of [120, 250, 380]) { const c = await ink(p, 300, y, 1); const l = await ink(p, 295, y, 0); const r = await ink(p, 305, y, 0); if (!isCol(c, DARK) || !empty(l) || !empty(r)) return `y=${y}: ${c.join(',')} / ${l.join(',')} / ${r.join(',')}`; } return true; });
  // Verschieben: an der Linie ziehen
  await drag(a, [300, 250], [450, 300]); await sleep(2500);
  await both('1 senkrechte Linie verschoben', lineState(4));
  await both('1 verschoben: weiterhin senkrecht bei x=450', probes([[450, 150, DARK], [450, 440, DARK], [445, 300, null]].map(([x, y, w]) => [x, y, w])));
  // Wieder Endpunkt ziehen: unten (450,450) → (650,450)
  await drag(a, [450, 450], [650, 450]); await sleep(2500);
  await both('1 nach dem Verschieben wieder Endpunkt gezogen', lineState(5));
  await both('1 fester Endpunkt oben (450,140) unverändert', probes([[451, 142, DARK], [450, 400, null]]));
  // Mindestlänge: Endpunkt auf den anderen ziehen → letzter gültiger Zustand bleibt
  const evBefore = (await ovl(a)).e;
  await drag(a, [650, 450], [450, 140, 1, 1]); await sleep(1500);
  await both('1 Mindestlänge: Linie fällt nicht zusammen (sichtbarer Rest)', async p => (await inkCount(p, 450, 140, 12)) > 4 || 'keine Linie mehr');
  await undoKey(a);
  await both('1 Mindestlänge: ein Strg+Z stellt den Zustand davor her', lineState(5));
  ok((await ovl(a)).e <= evBefore + 2, '1 Mindestlänge: höchstens ein edit + ein undo', `events ${evBefore} → ${(await ovl(a)).e}`);
  await count('1 weiterhin 2 Objekte', 2);
  await reloadBoth();
  await both('1 nach Reload beider: letzter Zustand', lineState(5));
  // Strg+Z-Kette zurück bis zum Original, Redo-Kette wieder vor
  await tool(a, 'select');
  for (let k = 4; k >= 0; k--) { await undoKey(a); await both(`1 Strg+Z → Zustand ${k}`, lineState(k)); }
  for (let k = 1; k <= 5; k++) { await redoKey(a); await both(`1 Redo → Zustand ${k}`, lineState(k)); }
  await count('1 nach der Kette: 2 Objekte', 2);
  // Pfeil: Spitze am richtigen Ende
  const headAt = (tip, tail) => async p => { const [t, e] = [await inkCount(p, tip[0], tip[1], 9), await inkCount(p, tail[0], tail[1], 9)]; return (t > e * 1.4 && e > 0) || `spitze=${t} ende=${e}`; };
  await both('1 Pfeil: Spitze bei (900,200)', headAt([900, 200], [700, 100]));
  await tap(a, [800, 150]);
  await drag(a, [700, 100], [1050, 300]); await sleep(2500);
  await both('1 Pfeil umgeklappt (Ende nach rechts unten gezogen): Spitze bleibt bei (900,200)', headAt([900, 200], [1050, 300]));
  await both('1 Pfeil umgeklappt: altes Ende leer, Schaft liegt neu', probes([[700, 100, null], [800, 150, null], [975, 250, DARK]]));
  await shot(a, 'auswahl-pfeil-umgeklappt.png');
  await drag(a, [900, 200], [1000, 500]); await sleep(2500);
  await both('1 Pfeil: Spitze gezogen — sitzt jetzt bei (1000,500)', headAt([1000, 500], [1050, 300]));
  await both('1 Pfeil: alte Spitze leer', probes([[900, 200, null], [1025, 400, DARK]]));

  // ── 2. Gleichzeitig: A zieht Endpunkt, B verschiebt dieselbe Linie ──────
  await pickShape(a, 'line'); await drag(a, [100, 520], [300, 560]); await sleep(2500);
  await count('2 dritte Linie auf beiden', 3);
  await tool(a, 'select'); await tool(b, 'select');
  await tap(a, [200, 540]); await tap(b, [200, 540]);
  ok((await sel(a)).kind === 'linie' && (await sel(b)).kind === 'linie', '2 Linie auf A und B gewählt');
  await Promise.all([drag(a, [300, 560], [300, 640]), drag(b, [200, 540], [400, 540])]);
  await sleep(3000);
  const simPts = [[100, 520], [200, 540], [300, 560], [200, 580], [300, 640], [300, 520], [400, 540], [500, 560], [400, 580], [500, 640], [350, 580]];
  const simRead = async p => { const out = []; for (const [x, y] of simPts) out.push((await ink(p, x, y))[3] > 140 ? 1 : 0); return out.join(''); };
  let [sa, sb] = [await simRead(a), await simRead(b)];
  ok(sa === sb && /1/.test(sa), '2 gleichzeitig Endpunkt/Verschieben: nach 3 s identische Proben auf A und B', `A=${sa} B=${sb}`);
  await sameSig('2 identisches Bild auf A und B');
  await reloadBoth();
  [sa, sb] = [await simRead(a), await simRead(b)];
  ok(sa === sb && /1/.test(sa), '2 nach Reload beider: identische Proben', `A=${sa} B=${sb}`);
  await sameSig('2 nach Reload: identisches Bild');
  await count('2 drei Objekte', 3);

  // ── 3. Kleines Objekt: nur Eckgriffe, Ziehen in der Mitte verschiebt ────
  const k3 = (await ovl(a)).view.k;
  const d30 = 30 / k3;
  await pickShape(a, 'rect'); await drag(a, [700, 600], [700 + d30, 600 + d30]); await sleep(300);
  await tool(a, 'select'); await tap(a, [700, 600 + d30 / 2]);
  s = await sel(a);
  ok(s.n === 1 && s.kind === 'rechteck' && s.handles === 4, '3 kleines Objekt (30×30 px): nur 4 Eckgriffe', JSON.stringify(s));
  await drag(a, [700 + d30 / 2, 600 + d30 / 2], [760 + d30 / 2, 600 + d30 / 2]); await sleep(2500);
  await both('3 Ziehen in der Mitte verschiebt (Größe unverändert)', probes([[760, 600 + d30 / 2, DARK], [760 + d30, 600 + d30 / 2, DARK], [700, 600 + d30 / 2, null], [760 + d30 / 2, 600 + d30 / 2, null]]));
  // schmal und hoch: Griffe oben/unten Mitte entfallen, links/rechts bleiben
  await pickShape(a, 'rect'); await drag(a, [850, 560], [850 + d30, 560 + 100 / k3]); await sleep(300);
  await tool(a, 'select'); await tap(a, [850, 560 + 50 / k3]);
  s = await sel(a);
  ok(s.kind === 'rechteck' && s.handles === 6, '3 schmales Objekt (30×100 px): 6 Griffe (ohne oben/unten Mitte)', JSON.stringify(s));
  await sleep(2000);
  await count('3 fünf Objekte', 5);

  // ── 4. Auswahlrechteck, Umschalt+Klick, Strg+A, Esc ─────────────────────
  await newPage(2);
  await pickShape(a, 'rect'); await drag(a, [100, 100], [200, 180]);
  await pickShape(a, 'ellipse'); await drag(a, [260, 100], [360, 180]);
  await pickShape(a, 'line'); await drag(a, [420, 100], [520, 180]);
  await pickShape(a, 'rect'); await drag(a, [100, 300], [200, 380]);
  await tool(a, 'pen'); await drag(a, [260, 340], [360, 340]);
  await sleep(2500);
  await count('4 fünf Objekte auf Seite 2', 5);
  await tool(a, 'select');
  ok((await sel(a)).n === 0, '4 vor dem Aufziehen nichts gewählt');
  await marquee(a, [60, 60], [560, 220], { hold: async () => { await sleep(150); await shot(a, 'auswahl-rechteck-aufziehen.png'); } });
  s = await sel(a);
  ok(s.n === 3 && s.kind === 'gruppe' && s.handles === 8, '4 Auswahlrechteck um 3 von 5: 3 gewählt, ein Rahmen mit 8 Griffen', JSON.stringify(s));
  ok(await a.evaluate(() => { const c = document.getElementById('sel-count'); return !c.hidden && c.textContent === '3 Objekte'; }), '4 Leiste zeigt „3 Objekte“');
  await shot(a, 'auswahl-gruppe.png');
  await a.emulateMedia({ colorScheme: 'dark' }); await sleep(500);
  await shot(a, 'auswahl-gruppe-dark.png');
  await a.emulateMedia({ colorScheme: 'light' }); await sleep(300);
  await tap(a, [100, 340], 'Shift');
  ok((await sel(a)).n === 4, '4 Umschalt+Klick fügt ein Objekt hinzu', JSON.stringify(await sel(a)));
  await tap(a, [260, 140], 'Shift');
  ok((await sel(a)).n === 3, '4 Umschalt+Klick nimmt eines heraus', JSON.stringify(await sel(a)));
  await tap(a, [310, 340], 'Control');
  ok((await sel(a)).n === 4, '4 Strg+Klick fügt hinzu', JSON.stringify(await sel(a)));
  await a.keyboard.press('Control+a'); await sleep(250);
  ok((await sel(a)).n === 5, '4 Strg+A wählt alle', JSON.stringify(await sel(a)));
  await a.keyboard.press('Escape'); await sleep(250);
  ok((await sel(a)).n === 0 && !(await selShown(a)), '4 Esc: keine Auswahl');
  await marquee(a, [600, 500], [700, 600]);
  ok((await sel(a)).n === 0, '4 Auswahlrechteck ins Leere wählt nichts');

  // ── 5. Gruppe verschieben, skalieren, färben, füllen ────────────────────
  await marquee(a, [60, 60], [560, 220]);
  const ev5 = (await ovl(a)).e;
  await drag(a, [150, 100], [650, 100]); await sleep(2500); // an der Oberkante des Rechtecks, neben den Griffen
  const moved = probes([[600, 140, DARK], [100, 140, null], [760, 140, DARK], [260, 140, null], [970, 140, DARK], [470, 140, null], [100, 340, DARK]]);
  const unmoved = probes([[600, 140, null], [100, 140, DARK], [760, 140, null], [260, 140, DARK], [970, 140, null], [470, 140, DARK], [100, 340, DARK]]);
  await both('5 Gruppe verschoben: alle drei auf beiden an neuer Stelle, die anderen unberührt', moved);
  ok((await ovl(a)).e === ev5 + 3, '5 drei edit-Events', `${ev5} → ${(await ovl(a)).e}`);
  ok((await sel(a)).n === 3, '5 Gruppe bleibt gewählt');
  await undoKey(a);
  await both('5 EIN Strg+Z bringt alle zurück', unmoved);
  await redoKey(a);
  await both('5 EIN Redo bringt alle wieder hin', moved);
  // Skalieren über den Eckgriff unten rechts: Breite ×0,5, Höhe ×2 um die Ecke (600,100)
  const k5 = (await ovl(a)).view.k;
  await drag(a, [1020, 180, 7, 7], [810, 260, 7, 7]); await sleep(2500);
  const scaled = probes([[650, 180, DARK], [600, 180, DARK], [625, 260, DARK], [700, 140, null], [680, 180, DARK], [730, 180, DARK], [785, 180, DARK], [970, 140, null], [760, 110, DARK], [810, 250, DARK]]);
  await both('5 Gruppe skaliert: Größen und Abstände gemeinsam (Rechteck 50×160, Ellipse ab 680, Linie 760–810)', scaled);
  await undoKey(a);
  await both('5 ein Strg+Z nimmt das Skalieren zurück', moved);
  // Umfärben: alle drei rot
  ok((await sel(a)).n === 3, '5 Gruppe weiterhin gewählt', JSON.stringify(await sel(a)));
  await a.click('#btn-sel-color'); await a.click(`#sel-color-swatches .swatch[data-color="${RED}"]`); await sleep(2500);
  await both('5 Gruppe umgefärbt: alle drei rot', probes([[600, 140, RED], [760, 140, RED], [970, 140, RED], [100, 340, DARK]]));
  await undoKey(a);
  await both('5 ein Strg+Z: alle wieder dunkel', probes([[600, 140, DARK], [760, 140, DARK], [970, 140, DARK]]));
  await redoKey(a);
  await both('5 ein Redo: alle wieder rot', probes([[600, 140, RED], [760, 140, RED], [970, 140, RED]]));
  // Füllung: nur Rechteck und Ellipse
  ok(await a.evaluate(() => !document.getElementById('sel-fill-wrap').hidden), '5 Füllung sichtbar (Rechteck/Ellipse dabei)');
  const ev5f = (await ovl(a)).e;
  await a.click('#btn-sel-fill'); await a.click(`#sel-fill-swatches .swatch[data-color="${YELLOW}"]`); await sleep(2500);
  await both('5 Füllung nur für Rechteck und Ellipse', probes([[650, 140, YELLOW], [810, 140, YELLOW], [990, 130, null]]));
  ok((await ovl(a)).e === ev5f + 2, '5 Füllung: zwei edit-Events (Linie nicht)', `${ev5f} → ${(await ovl(a)).e}`);
  await undoKey(a);
  await both('5 ein Strg+Z: Füllung bei beiden weg', probes([[650, 140, null], [810, 140, null]]));
  await redoKey(a);
  await both('5 ein Redo: Füllung wieder da', probes([[650, 140, YELLOW], [810, 140, YELLOW]]));
  // Linie + Stiftstrich: keine Füllung in der Leiste
  await a.keyboard.press('Escape'); await tap(a, [970, 140]); await tap(a, [310, 340], 'Shift');
  ok((await sel(a)).n === 2 && await a.evaluate(() => document.getElementById('sel-fill-wrap').hidden), '5 Linie + Stiftstrich: Füllung ausgeblendet', JSON.stringify(await sel(a)));
  // Pfeiltasten schieben die Gruppe, ein Schritt
  await a.keyboard.press('Shift+ArrowDown'); await a.keyboard.press('Shift+ArrowDown'); await sleep(2800);
  await both('5 Pfeiltasten: beide um 20 px verschoben', probes([[970, 140 + 20 / k5, RED], [310, 340 + 20 / k5, DARK], [310, 340, null]]));
  await undoKey(a);
  await both('5 ein Strg+Z nimmt das Schieben beider zurück', probes([[970, 140, RED], [310, 340, DARK], [310, 340 + 20 / k5, null]]));
  await count('5 weiterhin 5 Objekte', 5);

  // ── 6. Gruppe duplizieren und löschen ───────────────────────────────────
  await a.keyboard.press('Escape'); await marquee(a, [570, 60], [1060, 220]);
  ok((await sel(a)).n === 3, '6 drei gewählt', JSON.stringify(await sel(a)));
  await a.click('#btn-sel-duplicate'); await sleep(2500);
  await count('6 dupliziert: +3 auf beiden', 8);
  ok((await sel(a)).n === 3, '6 die Kopien sind gewählt', JSON.stringify(await sel(a)));
  await both('6 Kopien um 16 px versetzt', probes([[600 + 16 / k5, 150, RED], [760 + 16 / k5, 140 + 16 / k5, RED]]));
  await undoKey(a);
  await count('6 ein Strg+Z entfernt alle Kopien', 5);
  await redoKey(a);
  await count('6 ein Redo bringt alle Kopien zurück', 8);
  await undoKey(a);
  await count('6 wieder 5', 5);
  await marquee(a, [570, 60], [1060, 220]);
  await a.keyboard.press('Delete'); await sleep(2500);
  await count('6 Gruppe gelöscht: 2 auf beiden', 2);
  ok(/3 Objekte gelöscht/.test(await toastText(a)) && /Rückgängig/.test(await toastText(a)) && (await sel(a)).n === 0, '6 Hinweis „3 Objekte gelöscht“ mit „Rückgängig“', await toastText(a));
  await a.evaluate(() => { const t = [...document.querySelectorAll('#toasts .toast')].find(t => /Objekte gelöscht/.test(t.textContent)); t.querySelector('button').click(); }); await sleep(2500);
  await count('6 „Rückgängig“ im Hinweis stellt alle her', 5);
  await both('6 wiederhergestellt: an alter Stelle', probes([[600, 140, RED], [760, 140, RED], [970, 140, RED]]));
  await marquee(a, [570, 60], [1060, 220]);
  await a.click('#btn-sel-delete'); await sleep(2500);
  await count('6 erneut gelöscht', 2);
  await undoKey(a);
  await count('6 ein Strg+Z stellt alle drei her', 5);
  await redoKey(a);
  await count('6 Redo löscht wieder alle drei', 2);
  await undoKey(a);
  await count('6 und zurück: 5', 5);

  // ── 7. B löscht eines der bei A gewählten Objekte ───────────────────────
  await marquee(a, [570, 60], [1060, 220]);
  ok((await sel(a)).n === 3, '7 A hat drei gewählt');
  await tool(b, 'select'); await tap(b, [760, 140]);
  ok((await sel(b)).kind === 'ellipse', '7 B wählt die Ellipse', JSON.stringify(await sel(b)));
  await b.keyboard.press('Delete'); await sleep(3000);
  await count('7 B hat gelöscht: 4 auf beiden', 4);
  s = await sel(a);
  ok(s.n === 2 && s.kind === 'gruppe' && await selShown(a), '7 bei A fällt es aus der Auswahl, der Rest bleibt gewählt', JSON.stringify(s));
  await undoKey(b);
  await count('7 B nimmt das Löschen zurück: 5', 5);

  // ── 8. Gemischte Gruppe: Form, Füllfläche, Stiftstrich, Linie ───────────
  await a.keyboard.press('Escape');
  await newPage(3);
  await pickShape(a, 'rect'); await drag(a, [100, 100], [250, 220]);
  await tool(a, 'fill'); await tap(a, [175, 160]); await sleep(600);
  await tool(a, 'pen'); await drag(a, [300, 120], [400, 200]);
  await pickShape(a, 'line'); await drag(a, [450, 100], [550, 220]);
  await sleep(2500);
  await count('8 vier Objekte (Form, Füllfläche, Stiftstrich, Linie)', 4);
  await both('8 Ausgangslage', probes([[175, 100, DARK], [175, 160, DARK], [350, 160, DARK], [500, 160, DARK], [275, 360, null]]));
  await tool(a, 'select'); await a.keyboard.press('Control+a'); await sleep(250);
  ok((await sel(a)).n === 4 && (await sel(a)).kind === 'gruppe', '8 Strg+A: 4 gewählt', JSON.stringify(await sel(a)));
  await drag(a, [175, 160], [275, 360]); await sleep(2500);
  const mixMoved = probes([[275, 300, DARK], [275, 360, DARK], [450, 360, DARK], [600, 360, DARK], [175, 160, null], [350, 160, null], [500, 160, null]]);
  await both('8 gemischte Gruppe verschoben', mixMoved);
  await drag(a, [650, 420, 7, 7], [875, 480, 7, 7]); await sleep(2500);
  const mixScaled = probes([[312, 300, DARK], [312, 390, DARK], [425, 390, DARK], [575, 390, DARK], [800, 390, DARK], [875 - 3, 480 - 4, DARK], [450, 360, null], [600, 360, null], [500, 390, null]]);
  await both('8 gemischte Gruppe skaliert (×1,5): Form, Fläche, Strich und Linie passen zusammen', mixScaled);
  await count('8 weiterhin 4', 4);
  await reloadBoth();
  await gotoPage(a, 3); await gotoPage(b, 3);
  await both('8 nach Reload beider: gleicher Zustand', mixScaled);
  await sameSig('8 identisches Bild auf A und B');
  await tool(a, 'select');
  await undoKey(a);
  await both('8 ein Strg+Z (nach Reload): Skalieren aller vier zurück', mixMoved);
  await redoKey(a);
  await both('8 Redo: wieder skaliert', mixScaled);

  // ── 9. 200 Stiftstriche ziehen (Zeitmessung) ────────────────────────────
  await newPage(4);
  await tool(a, 'pen');
  { const bx = await box(a); const v = (await ovl(a)).view;
    for (let i = 0; i < 200; i++) {
      const x = bx.x + (60 + (i % 20) * 45) * v.k + v.x, y = bx.y + (60 + Math.floor(i / 20) * 45) * v.k + v.y;
      await a.mouse.move(x, y); await a.mouse.down(); await a.mouse.move(x + 12 * v.k, y + 10 * v.k); await a.mouse.move(x + 25 * v.k, y + 25 * v.k); await a.mouse.up();
    } }
  for (let i = 0; i < 40 && (await cnt(b)) < 200; i++) await sleep(500);
  await sleep(1500);
  await count('9 200 Stiftstriche auf beiden', 200);
  await tool(a, 'select'); await a.keyboard.press('Control+a'); await sleep(400);
  ok((await sel(a)).n === 200, '9 alle 200 gewählt', JSON.stringify(await sel(a)));
  const t9 = Date.now();
  await drag(a, [72, 70], [172, 220], { steps: 60 });
  const dragWall = Date.now() - t9 - 250;
  await sleep(1500);
  const zeit = ((await ovlText(a)).match(/auswahl-zeit: (.*)/) || [])[1] || '';
  console.log(`ZEIT 200 Objekte ziehen: ${zeit} (Geste gesamt ${dragWall} ms bei 60 Schritten)`);
  const num = re => Number((zeit.match(re) || [])[1]);
  const [zug, bild, los] = [num(/zug ([\d.]+) ms/), num(/bild ([\d.]+) ms/), num(/loslassen ([\d.]+) ms/)];
  ok(/^200 objekte/.test(zeit) && zug < 4 && bild < 50 && los < 500, '9 Ziehen von 200 Objekten: pro Pointer-Move < 4 ms, Bild < 50 ms, Loslassen < 500 ms', zeit);
  await sleep(3000);
  const far = [[72 + 100, 70 + 150, DARK], [72, 70, null], [60 + 19 * 45 + 12 + 100, 60 + 9 * 45 + 10 + 150, DARK], [60 + 19 * 45 + 12 + 100, 60 + 9 * 45 + 10 + 150 - 22, null]];
  await both('9 alle verschoben (erster und letzter Strich) auf A und B', probes(far));
  await count('9 weiterhin 200', 200);
  await sameSig('9 identisches Bild auf A und B', a, b, 100);
  await tool(a, 'select');
  await undoKey(a); await sleep(1500);
  await both('9 EIN Strg+Z bringt alle 200 zurück', probes([[72, 70, DARK], [72 + 100, 70 + 150 + 22, null], [60 + 19 * 45 + 12, 60 + 9 * 45 + 10, DARK]]));
  await redoKey(a); await sleep(1500);
  await both('9 EIN Redo verschiebt alle 200 wieder', probes(far));

  // ── 10. Sicherung: exportieren, in frischem Kontext einspielen ──────────
  await a.keyboard.press('Escape'); await sleep(1500);
  await a.click('#btn-notebooks'); await sleep(300); await a.click('#btn-settings'); await sleep(300); await a.click('#set-tab-data'); await sleep(300);
  await a.click('#btn-export-enc'); await a.waitForSelector('#backup-export-modal:not(.hidden)');
  await a.fill('#export-pass', PASS); await a.fill('#export-pass2', PASS);
  const [bk] = await Promise.all([a.waitForEvent('download', { timeout: 30000 }), a.click('#export-ok')]);
  const BK = `${OUT}/auswahl-backup.enc`; await bk.saveAs(BK); await sleep(500);
  for (let i = 0; i < 4; i++) { await a.keyboard.press('Escape'); await sleep(200); }
  const C = await mk('C', { blockRelay: true, noP2P: true }); const c = C.page;
  await c.goto(URL); await c.waitForSelector('#firststart-modal:not(.hidden)');
  const [chooser] = await Promise.all([c.waitForEvent('filechooser', { timeout: 10000 }), c.click('#btn-restore-backup')]); await chooser.setFiles(BK);
  await c.waitForSelector('#prompt-modal:not(.hidden)', { timeout: 8000 }).catch(() => {});
  await c.fill('#prompt-input', PASS); await c.keyboard.press('Enter');
  await c.waitForFunction(h => localStorage.getItem('notizbuch:masterKeyHash') === h, await a.evaluate(() => localStorage.getItem('notizbuch:masterKeyHash')), { timeout: 20000 }).catch(() => {});
  await ready(c).catch(() => {}); await sleep(3000);
  for (const [n, want] of [[1, 5], [2, 5], [3, 4], [4, 200]]) {
    await gotoPage(a, n); await gotoPage(c, n);
    const [oa, oc] = [await ovl(a), await ovl(c)];
    ok(oc.s === want && oa.s === want && oc.e === oa.e, `10 Sicherung, Seite ${n}: gleiche Objekt- und Event-Zahl`, `A=${oa.s}/${oa.e} C=${oc.s}/${oc.e}`);
    await sameSig(`10 Sicherung, Seite ${n}: identisches Bild`, a, c);
  }
  await gotoPage(c, 1);
  ok((await probes(P.map(([x, y], i) => [x, y, i === 5 ? DARK : null]))(c)) === true, '10 C: Linie im letzten Endpunkt-Zustand');
  await gotoPage(c, 3);
  ok((await mixScaled(c)) === true, '10 C: gemischte Gruppe skaliert', String(await mixScaled(c)));

  // ── 4b. Umschalter „Mehrere“ per Touch (eigener Kontext, Eingabe über CDP) ──
  const D = await mk('D', { touch: true, blockRelay: true, noP2P: true }); const d = D.page;
  await fresh(D); await sleep(2000);
  const cdp = await D.ctx.newCDPSession(d);
  const dbox = await box(d);
  const tp = pts => pts.map(([x, y], i) => ({ x: dbox.x + x, y: dbox.y + y, id: i }));
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: tp(pts) });
  const tdrag = async (from, to, steps = 6) => { await touch('touchStart', [from]); for (let i = 1; i <= steps; i++) { await touch('touchMove', [[from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps]]); await sleep(20); } await touch('touchEnd', []); await sleep(300); };
  const ttap = async (x, y) => { await touch('touchStart', [[x, y]]); await sleep(40); await touch('touchEnd', []); await sleep(300); };
  await d.click('[data-tool="shape"]'); await d.click('#pop-shapes [data-shape="rect"]'); await sleep(150);
  await tdrag([150, 150], [300, 260]); await tdrag([400, 150], [550, 260]); await tdrag([650, 150], [800, 260]);
  await d.click('#pop-shapes [data-shape="line"]').catch(async () => { await d.click('[data-tool="shape"]'); await d.click('#pop-shapes [data-shape="line"]'); }); await sleep(150);
  await tdrag([150, 400], [400, 500]);
  ok(await cnt(d) === 4, '4b Touch: drei Rechtecke und eine Linie', `objekte=${await cnt(d)}`);
  await d.click('[data-tool="select"]'); await sleep(150);
  await ttap(150, 205);
  ok((await sel(d)).n === 1 && await d.evaluate(() => { const m = document.getElementById('btn-sel-multi'); const r = m.getBoundingClientRect(); return m.getAttribute('aria-pressed') === 'false' && r.height >= 44 && r.width >= 44; }), '4b Touch: ein Objekt gewählt, Umschalter „Mehrere“ aus (mindestens 44×44)');
  const mb = await d.evaluate(() => { const r = document.getElementById('btn-sel-multi').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await touch('touchStart', [[mb[0] - dbox.x, mb[1] - dbox.y]]); await sleep(40); await touch('touchEnd', []); await sleep(300);
  ok(await d.evaluate(() => document.getElementById('btn-sel-multi').getAttribute('aria-pressed') === 'true') && (await sel(d)).multi, '4b „Mehrere“ eingeschaltet (aria-pressed)', JSON.stringify(await sel(d)));
  await ttap(400, 205); await ttap(650, 205);
  s = await sel(d);
  ok(s.n === 3 && s.kind === 'gruppe' && s.multi, '4b zwei Tipps fügen zwei Objekte hinzu (3 gewählt)', JSON.stringify(s));
  await ttap(400, 205);
  ok((await sel(d)).n === 2, '4b Tipp auf ein gewähltes Objekt nimmt es heraus', JSON.stringify(await sel(d)));
  await ttap(900, 600);
  ok((await sel(d)).n === 2, '4b Tipp ins Leere lässt die Auswahl stehen, solange „Mehrere“ an ist');
  // Gruppe mit dem Finger verschieben
  await tdrag([225, 205], [225, 305]);
  ok((await probe(225, 250, DARK)(d)) === true && (await probe(725, 250, DARK)(d)) === true && (await probe(225, 150, null)(d)) === true && (await probe(475, 150, DARK)(d)) === true, '4b Touch: Gruppe (2) mit dem Finger verschoben, das dritte bleibt');
  await d.keyboard.press('Escape'); await sleep(200);
  ok((await sel(d)).n === 0, '4b Esc hebt auf');
  // Linie: Endpunkt mit dem Finger (Ansatz 16 px neben dem Griff)
  await ttap(275, 450);
  ok((await sel(d)).kind === 'linie' && (await sel(d)).handles === 2 && !(await sel(d)).multi, '4b Touch: Linie gewählt, 2 Griffe, „Mehrere“ wieder aus', JSON.stringify(await sel(d)));
  await tdrag([412, 510], [412, 610]);
  ok((await probe(275, 500, DARK, 3)(d)) === true && (await probe(275, 450, null)(d)) === true && (await probe(152, 401, DARK)(d)) === true, '4b Touch: Endpunkt mit dem Finger gezogen (16 px neben dem Griff angesetzt)', `${await probe(275, 500, DARK)(d)} ${await probe(275, 450, null)(d)}`);

  // ── 11. 360 × 740 ───────────────────────────────────────────────────────
  await gotoPage(a, 2);
  await a.setViewportSize({ width: 360, height: 740 }); await sleep(800);
  await a.click('#btn-fit'); await sleep(400);
  await tool(a, 'select'); await a.keyboard.press('Control+a'); await sleep(400);
  s = await sel(a);
  const bar = await a.evaluate(() => { const r = document.getElementById('selbar').getBoundingClientRect(); const kids = [...document.querySelectorAll('#selbar > *')].filter(e => !e.hidden).map(e => e.id || e.firstElementChild?.id); return { left: r.left, right: r.right, w: r.width, kids, multi: !!document.getElementById('btn-sel-multi').offsetWidth, count: document.getElementById('sel-count').textContent }; });
  ok(s.n === 5 && await selShown(a) && bar.left >= 0 && bar.right <= 360 && bar.multi && bar.count === '5 Objekte' && await noHScroll(a), '11 360×740: Leiste mit Farbe, Füllung, Duplizieren, Löschen, Anzahl und „Mehrere“ ganz im Bild, kein horizontaler Scroll', JSON.stringify(bar));
  await shot(a, 'auswahl-gruppe-360.png');
  await a.click('#btn-sel-multi'); await sleep(200);
  ok(await a.evaluate(() => document.getElementById('btn-sel-multi').getAttribute('aria-pressed') === 'true') && await noHScroll(a), '11 360: „Mehrere“ schaltbar');
  await a.keyboard.press('Escape'); await sleep(200);
  await a.setViewportSize({ width: 1400, height: 900 }); await sleep(600);

  // ── Abschluss: keine nativen Dialoge, keine Konsolenfehler ──────────────
  for (const X of all) {
    ok(X.dialogs.length === 0, `11 kein nativer Dialog (${X.name})`, X.dialogs.join(' | '));
    const bad = X.logs.filter(l => /PAGEERROR|^error|ReferenceError|TypeError|fehlgeschlagen/.test(l) && !/User-Initiated Abort|WebRTC blockiert|Relay blockiert|ERR_CONNECTION|WebSocket/.test(l));
    ok(bad.length === 0, `11 keine Konsolenfehler (${X.name})`, bad.slice(0, 6).join('\n  '));
  }
  if (process.env.LOGS) for (const X of all) console.log(`--- ${X.name}\n` + X.logs.slice(-30).join('\n'));
  await browser.close();
  console.log(fails ? `ERGEBNIS: ${fails} FEHLER` : 'ERGEBNIS: ALLES OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TESTFEHLER', e); process.exit(2); });
