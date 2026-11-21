// Test Füllwerkzeug: node fill.cjs <URL>
// Zwei isolierte Kontexte im Geräte-Sync (NO_P2P=1 blockiert WebRTC — der Relay-Live-Weg muss reichen),
// dazu je ein Kontext für die eingespielte Sicherung, die Zeitmessung (1400×900, DPR 2) und Touch (CDP).
// Prüft: Füllen von Form und Freihand-Schleife (kein heller Saum), offene Fläche / leere Seite / Tipp auf
// Linie, Insel (Loch), Umfärben + Rückgängig/Wiederholen, Radierer, späterer Strich, Auswahl (verschieben,
// Größe, Farbe, Duplizieren, Löschen), Zoom und Pan, Reload, Vorschau/PNG/SVG, Sicherung, alter Renderer.
// Koordinaten im Test sind Weltkoordinaten; die Ansicht steht in der Overlay-Zeile 'ansicht: scale x y'.
// Endet mit 'ERGEBNIS: ALLES OK' (Exit 0) oder 'ERGEBNIS: n FEHLER' (Exit 1).
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const URL = process.argv[2] || 'https://localhost:4444/app.html';
const OUT = process.env.OUT || '/tmp/notes-ui';
const PASS = 'Fuellen-Test-Passphrase-1';
const OLD_COMMIT = '176fc41';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (cond, label, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${extra !== '' ? ' — ' + extra : ''}`); };
const unchecked = [];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--ignore-certificate-errors'] });
  const all = [];
  const mk = async (name, opts = {}) => {
    const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1200, height: 800 }, deviceScaleFactor: opts.dpr || 1, ignoreHTTPSErrors: true, acceptDownloads: true, colorScheme: 'light', hasTouch: !!opts.touch });
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
  const ovl = p => p.evaluate(() => { const t = document.getElementById('console')?.innerText || ''; const m = t.match(/striche: (\d+) \(events: (\d+)\)/); const v = t.match(/ansicht: ([\d.]+) (-?[\d.]+) (-?[\d.]+)/); const f = t.match(/füllen: ([^\n]*)/); return { s: m ? Number(m[1]) : -1, e: m ? Number(m[2]) : -1, view: v ? { k: Number(v[1]), x: Number(v[2]), y: Number(v[3]) } : null, fill: f ? f[1] : '' }; });
  const cnt = async p => (await ovl(p)).s;
  const box = p => p.evaluate(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height }; });
  /** Weltkoordinate → Position im Fenster */
  const scr = async (p, wx, wy) => { const b = await box(p); const v = (await ovl(p)).view; return { x: b.x + wx * v.k + v.x, y: b.y + wy * v.k + v.y }; };
  const drag = async (p, a, b, { steps = 8 } = {}) => {
    const s = await scr(p, a[0], a[1]), e = await scr(p, b[0], b[1]);
    await p.mouse.move(s.x, s.y); await p.mouse.down();
    for (let i = 1; i <= steps; i++) await p.mouse.move(s.x + (e.x - s.x) * i / steps, s.y + (e.y - s.y) * i / steps);
    await p.mouse.up();
    await sleep(200);
  };
  /** Freihand-Linie durch Weltpunkte */
  const path2 = async (p, pts) => {
    const b = await box(p); const v = (await ovl(p)).view; const S = ([x, y]) => [b.x + x * v.k + v.x, b.y + y * v.k + v.y];
    const [x0, y0] = S(pts[0]); await p.mouse.move(x0, y0); await p.mouse.down();
    for (const q of pts.slice(1)) { const [x, y] = S(q); await p.mouse.move(x, y); }
    await p.mouse.up(); await sleep(200);
  };
  const tap = async (p, wx, wy) => { const s = await scr(p, wx, wy); await p.mouse.click(s.x, s.y); await sleep(250); };
  /** Farbe der Strich-Ebene an einer Weltkoordinate: [r,g,b,a] */
  const ink = async (p, wx, wy) => { const v = (await ovl(p)).view; return p.evaluate(([x, y]) => { const c = document.getElementById('static-canvas'); const k = c.width / c.getBoundingClientRect().width; return [...c.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data]; }, [wx * v.k + v.x, wy * v.k + v.y]); };
  /** Strecke zwischen zwei Weltpunkten auf der Strich-Ebene: Anzahl nicht deckender Pixel (heller Saum) */
  const seam = async (p, a, b) => { const v = (await ovl(p)).view; return p.evaluate(([x0, y0, x1, y1]) => { const c = document.getElementById('static-canvas'); const k = c.width / c.getBoundingClientRect().width; const ctx = c.getContext('2d'); const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * k); let holes = 0, minA = 255; for (let i = 0; i <= n; i++) { const d = ctx.getImageData(Math.round((x0 + (x1 - x0) * i / n) * k), Math.round((y0 + (y1 - y0) * i / n) * k), 1, 1).data; if (d[3] < 250) holes++; if (d[3] < minA) minA = d[3]; } return { holes, minA, n }; }, [a[0] * v.k + v.x, a[1] * v.k + v.y, b[0] * v.k + v.x, b[1] * v.k + v.y]); };
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const isCol = (px, h, tol = 45) => px[3] > 200 && hex(h).every((c, i) => Math.abs(px[i] - c) <= tol);
  const DARK = '#14171c', RED = '#e03131', YELLOW = '#f2c200', BLUE = '#1971c2', GREEN = '#2f9e44';
  const empty = px => px[3] === 0;
  /** Prüft dieselbe Bedingung auf A und B */
  const both = async (label, fn) => { const r = []; for (const X of [A, B]) r.push(await fn(X.page)); ok(r.every(x => x === true), label, r.every(x => x === true) ? '' : `A=${JSON.stringify(r[0])} B=${JSON.stringify(r[1])}`); };
  const probe = (wx, wy, want) => async p => { const px = await ink(p, wx, wy); return (want === null ? empty(px) : isCol(px, want)) || `${wx}/${wy}:${px.join(',')}`; };
  /** Mehrere Proben: [[x, y, Farbe|null], …] */
  const probes = list => async p => { for (const [x, y, want] of list) { const r = await probe(x, y, want)(p); if (r !== true) return r; } return true; };
  const count = async (label, want) => { const [a, b] = [await cnt(A.page), await cnt(B.page)]; ok(a === want && b === want, label, `A=${a} B=${b} (soll ${want})`); };
  const selShown = p => p.evaluate(() => !document.getElementById('selbar').hidden);
  const toast = (p, re) => p.evaluate(src => [...document.querySelectorAll('#toasts .toast')].some(t => new RegExp(src).test(t.textContent)), re.source);
  const setCol = async (p, h) => { await p.click('#btn-color'); await p.click(`#color-swatches [data-color="${h}"]`); await sleep(100); if (await p.evaluate(() => !document.getElementById('pop-color').hidden)) await p.click('#btn-color'); await sleep(100); };
  const key = async (p, k) => { await p.keyboard.press(k); await sleep(120); };
  const pickShape = async (p, type) => { await p.click('[data-tool="shape"]'); await p.click(`#pop-shapes [data-shape="${type}"]`); await sleep(120); };
  /** Form in Dunkel aufziehen */
  const shape = async (p, type, a, b) => { await pickShape(p, type); await drag(p, a, b); };
  /** Mit dem Füllwerkzeug in einer Farbe tippen */
  const fill = async (p, col, wx, wy) => { await setCol(p, col); await key(p, 'f'); await tap(p, wx, wy); };
  const reload = async X => { await X.page.reload(); await ready(X.page).catch(() => {}); };
  const reloadBoth = async () => { await Promise.all([reload(A), reload(B)]); await sleep(7000); };
  const undoKey = async p => { await p.keyboard.press('Control+z'); await sleep(1800); };
  const redoKey = async p => { await p.keyboard.press('Control+Shift+Z'); await sleep(1800); };
  const shot = (p, name) => p.screenshot({ path: `${OUT}/${name}` });
  const noHScroll = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
  const SYNC = 2500;

  // ── Aufbau: zwei Geräte mit demselben Schlüssel ─────────────────────────
  const A = await mk('A'), B = await mk('B');
  await fresh(A); await sleep(3000);
  const keyHex = await A.page.evaluate(() => JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw')).map(b => b.toString(16).padStart(2, '0')).join(''));
  await B.page.goto(URL + '#' + keyHex); await ready(B.page).catch(() => {});
  await sleep(8000);
  const a = A.page, b = B.page;
  if (process.env.NO_P2P) { const p2p = /↳[^;]*connected/.test(await a.evaluate(() => document.getElementById('console').innerText)); ok(!p2p, 'ohne P2P (nur Relay)'); }
  ok(/select-v49/.test(await a.evaluate(() => document.getElementById('console').innerText)), 'Version select-v49');
  const v0 = [(await ovl(a)).view, (await ovl(b)).view];
  ok(v0.every(v => v && v.k === 1 && v.x === 0 && v.y === 0), 'Ausgangsansicht auf beiden 1:1', JSON.stringify(v0));
  ok(await a.evaluate(() => document.querySelectorAll('canvas')[2]?.id === 'active-canvas'), 'canvas[2] ist die aktive Zeichenfläche');
  const nCanvas = await a.evaluate(() => document.querySelectorAll('canvas').length);

  // ── 0. Werkzeug + leere Seite ───────────────────────────────────────────
  await key(a, 'f');
  ok(await a.evaluate(() => { const btn = document.querySelector('.tools [data-tool="fill"]'); const order = [...document.querySelectorAll('.tools [data-tool]')].map(e => e.dataset.tool).join(','); return btn.getAttribute('aria-pressed') === 'true' && order === 'pen,eraser,fill,shape,select' && getComputedStyle(btn.querySelector('.lbl')).display !== 'none' && btn.querySelector('.lbl').textContent === 'Füllen'; }), '0 Taste F wählt „Füllen“ (zwischen Radierer und Formen, ab 1180 px beschriftet)');
  await tap(a, 400, 300);
  ok(await toast(a, /nicht geschlossen/) && await cnt(a) === 0, '3 Tipp auf leere Seite: Hinweis „nicht geschlossen“, kein Objekt');

  // ── 1. Rechteck-Form füllen ─────────────────────────────────────────────
  await shape(a, 'rect', [100, 100], [300, 220]);
  await fill(a, YELLOW, 200, 160);
  await sleep(SYNC);
  await count('1 Rechteck + Füllung: 2 Objekte', 2);
  await both('1 Inneres gefärbt (Mitte und knapp innerhalb der Ecken)', probes([[200, 160, YELLOW], [107, 107, YELLOW], [293, 213, YELLOW], [293, 107, YELLOW]]));
  await both('1 Kontur weiter in Linienfarbe (nicht überdeckt)', probes([[200, 100, DARK], [100, 160, DARK], [300, 160, DARK], [200, 220, DARK]]));
  await both('1 außen nichts gefärbt', probes([[200, 92, null], [92, 160, null], [308, 160, null], [200, 228, null], [330, 250, null]]));
  await both('1 kein heller Saum zwischen Füllung und Kontur', async p => { for (const to of [[100, 160], [300, 160], [200, 100], [200, 220], [100, 100]]) { const s = await seam(p, [200, 160], to); if (s.holes) return `${to}: ${JSON.stringify(s)}`; } return true; });
  ok(await a.evaluate(n => document.querySelectorAll('canvas').length === n, nCanvas), '1 kein zusätzliches Canvas im DOM');
  await shot(a, 'fuellen-rechteck.png');

  // ── 2. Freihand-Schleife füllen ─────────────────────────────────────────
  await key(a, 'p');
  const LC = [470, 165], lr = t => 60 + 8 * Math.sin(3 * t);
  const loop = []; for (let d = 0; d <= 384; d += 4) { const t = d * Math.PI / 180; loop.push([LC[0] + lr(t) * Math.cos(t), LC[1] + lr(t) * Math.sin(t)]); }
  await setCol(a, DARK); await key(a, 'p');
  await path2(a, loop);
  await fill(a, BLUE, LC[0], LC[1]);
  await sleep(SYNC);
  await count('2 Schleife + Füllung: 4 Objekte', 4);
  await both('2 Schleife innen gefärbt, außen leer', probes([[LC[0], LC[1], BLUE], [LC[0] + 40, LC[1], BLUE], [LC[0], LC[1] - 40, BLUE], [LC[0] + 85, LC[1], null], [LC[0], LC[1] + 85, null]]));
  await both('2 kein heller Saum zwischen Füllung und Linie (12 Strahlen von der Mitte zur Linie)', async p => { for (let d = 0; d < 360; d += 30) { const t = d * Math.PI / 180; const s = await seam(p, LC, [LC[0] + lr(t) * Math.cos(t), LC[1] + lr(t) * Math.sin(t)]); if (s.holes) return `${d}°: ${JSON.stringify(s)}`; } return true; });
  await both('2 Linie der Schleife bleibt dunkel', probes([[LC[0] + lr(0), LC[1], DARK]]));
  await shot(a, 'fuellen-schleife.png');

  // ── 3. Offene Form, Tipp auf Linie ──────────────────────────────────────
  await setCol(a, DARK); await key(a, 'p');
  await path2(a, [[650, 100], [650, 130], [650, 160], [650, 190], [650, 220], [690, 220], [730, 220], [770, 220], [770, 190], [770, 160], [770, 130], [770, 100]]);
  await sleep(600);
  await fill(a, RED, 710, 160);
  ok(await toast(a, /nicht geschlossen/), '3 offene Form (U): Hinweis „Fläche ist nicht geschlossen“');
  await shot(a, 'fuellen-nicht-geschlossen.png');
  ok((await probe(710, 160, null)(a)) === true, '3 offene Form: nichts gefärbt');
  await sleep(4800);
  await tap(a, 650, 160);
  ok(await toast(a, /in eine Fläche tippen/) && !(await toast(a, /nicht geschlossen/)), '3 Tipp genau auf eine Linie: Hinweis „Zum Füllen in eine Fläche tippen“');
  await sleep(SYNC);
  await count('3 Objektzahl nur um den U-Strich gewachsen: 5', 5);

  // ── 4. Fläche mit Insel ─────────────────────────────────────────────────
  await setCol(a, DARK);
  await shape(a, 'rect', [100, 300], [400, 520]);
  await shape(a, 'ellipse', [200, 360], [300, 460]);
  await fill(a, GREEN, 130, 330);
  const info4 = (await ovl(a)).fill; const rings4 = Number((info4.match(/ringe (\d+)/) || [])[1]);
  ok(rings4 >= 2, '4 Füllfläche hat Außenkontur + Loch (polys ≥ 2 Ringe)', info4);
  await sleep(SYNC);
  await count('4 Rechteck, Ellipse, Füllung: 8 Objekte', 8);
  await both('4 Ring zwischen Rechteck und Ellipse gefärbt', probes([[130, 330, GREEN], [370, 490, GREEN], [250, 340, GREEN], [250, 490, GREEN], [180, 410, GREEN]]));
  await both('4 Inneres der Ellipse nicht gefärbt, Konturen dunkel', probes([[250, 410, null], [225, 400, null], [250, 360, DARK], [100, 410, DARK]]));
  await shot(a, 'fuellen-insel.png');

  // ── 5. Umfärben, Rückgängig, Wiederholen ────────────────────────────────
  const ev5 = (await ovl(a)).e;
  await fill(a, RED, 370, 490);
  await sleep(SYNC);
  ok((await ovl(a)).e === ev5 + 1, '5 Umfärben erzeugt genau EIN Event (edit)', `${ev5} → ${(await ovl(a)).e}`);
  await count('5 Umfärben: Objektzahl unverändert 8', 8);
  await both('5 Fläche in neuer Farbe, Loch bleibt', probes([[130, 330, RED], [370, 490, RED], [250, 410, null]]));
  await tap(a, 370, 490); await sleep(600);
  ok((await ovl(a)).e === ev5 + 1, '5 Tipp mit derselben Farbe: kein weiteres Event');
  await undoKey(a);
  await both('5 Strg+Z: alte Farbe', probes([[130, 330, GREEN], [370, 490, GREEN]]));
  await count('5 nach Strg+Z weiter 8', 8);
  await undoKey(a);
  await both('5 Strg+Z: Füllung weg', probes([[130, 330, null], [370, 490, null], [100, 410, DARK]]));
  await count('5 nach zweitem Strg+Z: 7', 7);
  await redoKey(a);
  await both('5 Wiederholen: Füllung wieder da (alte Farbe)', probes([[130, 330, GREEN]]));
  await redoKey(a);
  await both('5 Wiederholen: neue Farbe', probes([[130, 330, RED], [370, 490, RED], [250, 410, null]]));
  await count('5 nach zweimal Wiederholen: 8', 8);

  // ── 6. Radierer ─────────────────────────────────────────────────────────
  await key(a, 'e');
  await drag(a, [200, 125], [200, 195], { steps: 8 });
  await sleep(SYNC);
  await both('6 Radierer durch die gefüllte Fläche: Spur transparent, Rest gefüllt', probes([[200, 160, null], [150, 160, YELLOW], [250, 160, YELLOW]]));
  // ältere Radierspur im Leeren, danach eine Form darüber
  await drag(a, [920, 80], [920, 300], { steps: 10 });
  await setCol(a, DARK);
  await shape(a, 'rect', [850, 120], [1000, 240]);
  await sleep(600);
  ok((await probe(920, 120, DARK)(a)) === true, '6 neue Form liegt über der älteren Radierspur');
  await fill(a, GREEN, 880, 180);
  await sleep(SYNC);
  await count('6 zwei Radierer, Form, Füllung: 12', 12);
  await both('6 Füllung auch dort, wo früher radiert wurde', probes([[920, 180, GREEN], [880, 180, GREEN], [970, 200, GREEN], [920, 127, GREEN], [920, 233, GREEN]]));
  await both('6 außerhalb der Form bleibt die Radierspur leer', probes([[920, 100, null], [920, 270, null]]));

  // ── 7. Späterer Strich liegt über der Füllung ───────────────────────────
  await setCol(a, BLUE); await key(a, 'p');
  await drag(a, [120, 205], [280, 205], { steps: 10 });
  await sleep(SYNC);
  await both('7 später gezeichneter Stiftstrich liegt über der Füllung', probes([[160, 205, BLUE], [240, 205, BLUE], [160, 195, YELLOW]]));
  await count('7 mit Stiftstrich: 13', 13);

  // ── 8. Auswahl ──────────────────────────────────────────────────────────
  await key(a, 'v');
  await tap(a, 250, 410);
  ok(!(await selShown(a)), '8 Tipp ins Loch der Füllfläche wählt nichts');
  await tap(a, 130, 330);
  ok(await selShown(a) && await a.evaluate(() => document.getElementById('sel-fill-wrap').hidden), '8 Füllfläche wählbar; Leiste ohne Knopf „Füllung“');
  await tap(a, 250, 360);
  ok(await selShown(a), '8 Tipp auf die Kontur der Ellipse wählt die Ellipse (Linie liegt über der Füllung)');
  ok(await a.evaluate(() => !document.getElementById('sel-fill-wrap').hidden), '8 … dort mit Knopf „Füllung“');
  await key(a, 'Escape'); await tap(a, 130, 330);
  const ev8 = (await ovl(a)).e;
  await drag(a, [130, 330], [550, 370], { steps: 12 }); await sleep(SYNC);
  ok((await ovl(a)).e === ev8 + 1, '8 Verschieben erzeugt genau EIN Event', `${ev8} → ${(await ovl(a)).e}`);
  await both('8 Füllfläche verschoben (samt Loch), Formen bleiben', probes([[550, 370, RED], [790, 530, RED], [670, 450, null], [130, 330, null], [100, 410, DARK], [250, 360, DARK]]));
  // Griff unten rechts: Rahmen = Fläche + 6,5 px
  await drag(a, [826, 566], [886, 606]); await sleep(SYNC);
  await both('8 Füllfläche vergrößert (linke obere Ecke fest)', probes([[870, 590, RED], [530, 350, RED], [850, 380, RED]]));
  await a.click('#btn-sel-color'); await sleep(200);
  await a.click(`#sel-color-swatches [data-color="${BLUE}"]`); await sleep(SYNC);
  await both('8 Farbe über die Leiste geändert', probes([[870, 590, BLUE], [530, 350, BLUE]]));
  await count('8 weiter 13 Objekte', 13);
  await a.click('#btn-sel-duplicate'); await sleep(SYNC);
  await count('8 Duplizieren: 14', 14);
  ok(await selShown(a), '8 die Kopie ist ausgewählt');
  await key(a, 'Delete'); await sleep(SYNC);
  await count('8 Löschen der Kopie: 13', 13);
  await both('8 Original steht noch', probes([[870, 590, BLUE]]));
  await key(a, 'v'); await tap(a, 530, 350); await key(a, 'Delete'); await sleep(SYNC);
  await count('8 Original gelöscht: 12', 12);
  await both('8 Fläche weg', probes([[870, 590, null], [530, 350, null]]));
  await undoKey(a); await count('8 Strg+Z: Original wieder da (13)', 13);
  await both('8 … in Blau an der vergrößerten Stelle', probes([[870, 590, BLUE]]));
  await undoKey(a); await count('8 Strg+Z: Kopie wieder da (14)', 14);
  await undoKey(a); await count('8 Strg+Z: Duplizieren zurück (13)', 13);
  await undoKey(a); await both('8 Strg+Z: Farbe zurück', probes([[870, 590, RED], [530, 350, RED]]));
  await undoKey(a); await both('8 Strg+Z: Größe zurück', probes([[870, 590, null], [550, 370, RED], [790, 530, RED]]));
  await undoKey(a); await both('8 Strg+Z: Position zurück — Fläche wieder deckungsgleich in der Form', probes([[130, 330, RED], [370, 490, RED], [250, 410, null], [550, 370, null], [107, 307, RED], [393, 513, RED], [92, 410, null]]));
  await count('8 nach der Kette 13 Objekte', 13);

  // ── 9. Zoom und Pan ─────────────────────────────────────────────────────
  await setCol(a, DARK);
  await shape(a, 'rect', [100, 560], [220, 660]);
  await shape(a, 'rect', [520, 300], [620, 400]);
  await shape(a, 'rect', [900, 400], [1040, 520]);
  for (let i = 0; i < 3; i++) await a.click('#btn-zoom-out'); await sleep(300);
  const z1 = (await ovl(a)).view.k;
  await fill(a, GREEN, 160, 610);
  for (let i = 0; i < 8; i++) await a.click('#btn-zoom-in'); await sleep(300);
  const z2 = (await ovl(a)).view.k;
  await fill(a, RED, 570, 350);
  await sleep(600);
  await shot(a, 'fuellen-zoom3.png');
  ok((await probes([[570, 350, RED], [527, 307, RED], [613, 393, RED], [520, 350, DARK], [512, 350, null]])(a)) === true, '9 Zoom 3: Füllung sitzt in der Form (bei Zoom 3 geprüft)', String(await probes([[570, 350, RED], [527, 307, RED], [613, 393, RED], [520, 350, DARK], [512, 350, null]])(a)));
  for (let i = 0; i < 5; i++) await a.click('#btn-zoom-out'); await sleep(300);
  const z3 = (await ovl(a)).view.k;
  ok(Math.abs(z1 - 0.512) < 0.01 && Math.abs(z2 - 3.05) < 0.03 && Math.abs(z3 - 1) < 0.001, '9 gefüllt bei Zoom 0,5 und 3, zurück bei 1', `${z1} / ${z2} / ${z3}`);
  // verschobene Ansicht
  await a.click('#btn-hand'); await sleep(150);
  { const bx = await box(a); await a.mouse.move(bx.x + 600, bx.y + 400); await a.mouse.down(); await a.mouse.move(bx.x + 450, bx.y + 300, { steps: 5 }); await a.mouse.up(); await sleep(300); }
  await a.click('#btn-hand'); await sleep(150);
  const vp = (await ovl(a)).view;
  ok(Math.abs(vp.x - (await ovl(b)).view.x) > 100, '9 Ansicht von A ist verschoben', JSON.stringify(vp));
  await fill(a, BLUE, 970, 460);
  await a.click('#btn-hand'); await sleep(150);
  { const bx = await box(a); await a.mouse.move(bx.x + 450, bx.y + 300); await a.mouse.down(); await a.mouse.move(bx.x + 600, bx.y + 400, { steps: 5 }); await a.mouse.up(); await sleep(300); }
  await a.click('#btn-hand'); await sleep(SYNC);
  await count('9 drei Formen + drei Füllungen: 19', 19);
  await both('9 bei Zoom 0,5 gefüllt: bei Zoom 1 deckungsgleich in der Form', probes([[160, 610, GREEN], [108, 568, GREEN], [212, 652, GREEN], [100, 610, DARK], [160, 560, DARK], [91, 610, null], [160, 551, null], [229, 610, null], [160, 669, null]]));
  await both('9 bei Zoom 3 gefüllt: bei Zoom 1 deckungsgleich in der Form', probes([[570, 350, RED], [527, 307, RED], [613, 393, RED], [520, 350, DARK], [513, 350, null], [627, 350, null], [570, 293, null], [570, 407, null]]));
  await both('9 bei verschobener Ansicht gefüllt: deckungsgleich in der Form', probes([[970, 460, BLUE], [907, 407, BLUE], [1033, 513, BLUE], [900, 460, DARK], [893, 460, null], [1047, 460, null], [970, 393, null], [970, 527, null]]));
  await both('9 kein heller Saum (alle drei)', async p => { for (const [from, to] of [[[160, 610], [100, 610]], [[160, 610], [160, 660]], [[570, 350], [620, 350]], [[570, 350], [570, 300]], [[970, 460], [900, 460]], [[970, 460], [970, 520]]]) { const s = await seam(p, from, to); if (s.holes) return `${from}→${to}: ${JSON.stringify(s)}`; } return true; });

  // Dunkles Theme: Papier bleibt weiß, Füllungen unverändert
  await a.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await sleep(300);
  await key(a, 'f');
  ok((await probes([[150, 150, YELLOW], [130, 330, RED]])(a)) === true, 'dunkles Theme: Füllungen unverändert');
  await shot(a, 'fuellen-dark.png');
  await a.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await sleep(200);

  // ── 10. Reload beider ───────────────────────────────────────────────────
  const state10 = [[150, 150, YELLOW], [200, 160, null], [470, 165, BLUE], [130, 330, RED], [250, 410, null], [920, 180, GREEN], [160, 610, GREEN], [570, 350, RED], [970, 460, BLUE], [710, 160, null], [240, 205, BLUE]];
  await both('10 vor dem Reload: Proben stimmen', probes(state10));
  await reloadBoth();
  await count('10 nach Reload beider: 19 Objekte', 19);
  await both('10 nach Reload beider: dieselben Proben', probes(state10));

  // ── 11. Vorschau, PNG, SVG, Sicherung ───────────────────────────────────
  await a.click('#btn-page-overview'); await sleep(2500);
  const thumb = await a.evaluate(() => { const c = document.querySelector('#pages-grid .thumb.current canvas') || document.querySelector('#pages-grid .thumb[data-page] canvas'); if (!c) return null; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let yellow = 0, red = 0, green = 0, white = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] > 200 && d[i + 1] > 160 && d[i + 2] < 90) yellow++; if (d[i] > 180 && d[i + 1] < 110 && d[i + 2] < 110) red++; if (d[i] < 110 && d[i + 1] > 120 && d[i + 2] < 120) green++; if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) white++; } return { yellow, red, green, white }; });
  ok(thumb && thumb.yellow > 30 && thumb.red > 30 && thumb.green > 30 && thumb.white > 1000, '11 Vorschaubild enthält die Füllungen (gelb, rot, grün) auf weißem Papier', JSON.stringify(thumb));
  await a.keyboard.press('Escape'); await sleep(300);
  const dl = async (btn, file) => { await a.click('#btn-page-menu'); const [d] = await Promise.all([a.waitForEvent('download', { timeout: 20000 }), a.click(btn)]); await d.saveAs(file); return file; };
  const pngFile = await dl('#btn-menu-export-png', `${OUT}/fuellen-export.png`);
  // Der Export zeigt den Inhalt mit 24 Einheiten Rand: Rechteck 1 (Kontur ab x=98, y=98) beginnt bei 24/24.
  const png = await a.evaluate(async b64 => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let yellow = 0; let minX = c.width, minY = c.height; for (let i = 0; i < d.length; i += 4) { if (d[i] > 220 && d[i + 1] > 170 && d[i + 2] < 60) { yellow++; const px = (i / 4) % c.width, py = Math.floor(i / 4 / c.width); if (px < minX) minX = px; if (py < minY) minY = py; } } const at = (px, py) => [...x.getImageData(px, py, 1, 1).data]; return { w: img.width, h: img.height, yellow, inner: at(minX + 20, minY + 20), outer: [at(3, 3), at(Math.max(0, minX - 20), Math.max(0, minY - 20)), at(c.width - 4, 3)] }; }, fs.readFileSync(pngFile).toString('base64'));
  const whiteish = px => px[3] === 255 && px[0] > 215 && px[1] > 225 && px[2] > 235;
  ok(png.yellow > 5000 && isCol(png.inner, YELLOW, 30) && png.outer.every(whiteish), '11 PNG-Export: Füllfarbe im Inneren, weißes Papier außen', JSON.stringify(png));
  const svg = fs.readFileSync(await dl('#btn-menu-export-svg', `${OUT}/fuellen-export.svg`), 'utf8');
  const fillPaths = svg.match(/<path d="M [^"]*Z" fill="#[0-9a-f]{6}" fill-rule="evenodd" stroke="none"\/>/g) || [];
  const svgN = { evenodd: fillPaths.length, mitLoch: fillPaths.filter(p => (p.match(/M /g) || []).length >= 2).length, vorStrichen: svg.lastIndexOf('fill-rule="evenodd"') < svg.indexOf('<ellipse '), maske: /<mask id="fill-eraser-mask-1"/.test(svg), alteMaske: /<mask id="eraser-mask">/.test(svg) };
  ok(svgN.evenodd === 7 && svgN.mitLoch >= 1 && svgN.vorStrichen && svgN.maske && svgN.alteMaske, '11 SVG-Export: 7 <path fill-rule="evenodd">, eine mit Loch, vor den Strichen einsortiert, eigene Radierer-Maske', JSON.stringify(svgN));
  const svgShown = await a.evaluate(async text => { const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text); await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let yellow = 0, green = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] > 220 && d[i + 1] > 170 && d[i + 2] < 60) yellow++; if (d[i] < 90 && d[i + 1] > 130 && d[i + 2] < 100) green++; } return { yellow, green }; }, svg);
  ok(svgShown.yellow > 5000 && svgShown.green > 5000, '11 SVG lässt sich darstellen und zeigt die Füllungen', JSON.stringify(svgShown));

  await a.click('#btn-notebooks'); await sleep(300); await a.click('#btn-settings'); await sleep(300); await a.click('#set-tab-data'); await sleep(300);
  await a.click('#btn-export-enc'); await a.waitForSelector('#backup-export-modal:not(.hidden)');
  await a.fill('#export-pass', PASS); await a.fill('#export-pass2', PASS);
  const [bk] = await Promise.all([a.waitForEvent('download', { timeout: 30000 }), a.click('#export-ok')]);
  const BK = `${OUT}/fuellen-backup.enc`; await bk.saveAs(BK); await sleep(500);
  for (let i = 0; i < 4; i++) { await a.keyboard.press('Escape'); await sleep(200); }
  const C = await mk('C', { blockRelay: true, noP2P: true }); const c = C.page;
  await c.goto(URL); await c.waitForSelector('#firststart-modal:not(.hidden)');
  const [chooser] = await Promise.all([c.waitForEvent('filechooser', { timeout: 10000 }), c.click('#btn-restore-backup')]); await chooser.setFiles(BK);
  await c.waitForSelector('#prompt-modal:not(.hidden)', { timeout: 8000 }).catch(() => {});
  await c.fill('#prompt-input', PASS); await c.keyboard.press('Enter');
  await c.waitForFunction(h => localStorage.getItem('notizbuch:masterKeyHash') === h, await a.evaluate(() => localStorage.getItem('notizbuch:masterKeyHash')), { timeout: 20000 }).catch(() => {});
  await ready(c).catch(() => {}); await sleep(3000);
  const [oa, oc] = [await ovl(a), await ovl(c)];
  ok(oc.s === 19 && oc.e === oa.e, '11 eingespielte Sicherung (Relay blockiert): gleiche Objekt- und Event-Zahl', `A=${oa.s}/${oa.e} C=${oc.s}/${oc.e}`);
  ok((await probes(state10)(c)) === true, '11 eingespielte Sicherung: Füllungen da (dieselben Proben)', String(await probes(state10)(c)));

  // ── 10b. Seite leeren ───────────────────────────────────────────────────
  await a.click('#btn-page-menu'); await a.click('#btn-clear'); await sleep(8500 + SYNC);
  await count('10 Seite geleert: 0 auf beiden', 0);
  await both('10 nach dem Leeren: Füllungen weg', probes([[150, 150, null], [130, 330, null], [970, 460, null]]));

  // ── 12. Altgerät: stroke-Event mit tool:'fill' durch den alten Renderer ──
  let oldSrc = '';
  try { oldSrc = execSync(`git show ${OLD_COMMIT}:js/canvas.js`, { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8' }); } catch (e) { oldSrc = ''; }
  if (!oldSrc) { ok(false, `12 alter Renderer (${OLD_COMMIT}:js/canvas.js) nicht lesbar`); }
  else {
    await a.addScriptTag({ content: `window.__oldCanvas = (function(){ ${oldSrc.replace(/^export /gm, '')}\n return { drawStrokeToCanvas }; })();` });
    const old = await a.evaluate(async () => {
      const m = await import('./js/canvas.js');
      const outer = [{ x: 40, y: 40 }, { x: 260, y: 40 }, { x: 260, y: 200 }, { x: 150, y: 230 }, { x: 40, y: 200 }];
      const hole = [{ x: 120, y: 90 }, { x: 180, y: 90 }, { x: 180, y: 150 }, { x: 120, y: 150 }];
      const good = { id: 'f1', createdAt: 1, tool: 'fill', color: '#e03131', size: 1, polys: [outer, hole], points: m.fillOutlinePoints([outer, hole]) };
      const odd = [good, { ...good, id: 'f2', polys: undefined }, { ...good, id: 'f3', points: [] }, { ...good, id: 'f4', polys: [[{ x: 1, y: 1 }]], points: [{ x: 1, y: 1 }] }, { ...good, id: 'f5', polys: 'x' }];
      const render = (fn, strokes) => { const c = document.createElement('canvas'); c.width = 300; c.height = 260; const x = c.getContext('2d'); let err = ''; try { for (const s of strokes) fn(x, s); } catch (e) { err = String(e); } const d = x.getImageData(0, 0, 300, 260).data; let ink = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 128) ink++; const at = (px, py) => d[(py * 300 + px) * 4 + 3] > 128; return { err, ink, op: x.globalCompositeOperation, edge: d[(40 * 300 + 150) * 4 + 3] + d[(39 * 300 + 150) * 4 + 3] > 150, inside: at(80, 120), hole: at(150, 120), url: c.toDataURL('image/png') }; };
      return { old: render(window.__oldCanvas.drawStrokeToCanvas, odd), neu: render(m.drawStrokeToCanvas, odd), hit: [m.hitTestStroke(good, 80, 120, 0), m.hitTestStroke(good, 150, 120, 0), m.hitTestStroke(good, 20, 20, 0)], moved: m.transformStroke(good, [2, 2, 10, 10]).polys[1][0] };
    });
    fs.writeFileSync(`${OUT}/altgeraet-fuellen.png`, Buffer.from(old.old.url.split(',')[1], 'base64'));
    ok(old.old.err === '' && old.old.ink > 200 && old.old.edge && !old.old.inside, '12 alter Renderer wirft nicht und zeichnet nur den Umriss', `err=${old.old.err} ink=${old.old.ink} kante=${old.old.edge} innen=${old.old.inside}`);
    ok(old.neu.err === '' && old.neu.inside && !old.neu.hole && old.neu.op === 'source-over', '12 neuer Renderer: Fläche gefüllt, Loch frei, kaputte Füllflächen werfen nicht, Modus danach wieder source-over', `err=${old.neu.err} innen=${old.neu.inside} loch=${old.neu.hole} op=${old.neu.op}`);
    ok(old.hit[0] === true && old.hit[1] === false && old.hit[2] === false && old.moved.x === 250 && old.moved.y === 190, '12 Treffertest nach evenodd; Abbildung wirkt auch auf die Löcher', JSON.stringify(old));
  }

  // ── 14. 360 × 740 ───────────────────────────────────────────────────────
  await a.setViewportSize({ width: 360, height: 740 }); await sleep(800);
  await a.click('#btn-fit'); await sleep(400);
  const row = await a.evaluate(() => { const bs = [...document.querySelectorAll('.toolrow button.tool, .toolrow button.opt, .toolrow button.mode')].map(e => e.getBoundingClientRect()); const tr = document.querySelector('.toolrow').getBoundingClientRect(); return { n: bs.length, minW: Math.min(...bs.map(r => r.width)), minH: Math.min(...bs.map(r => r.height)), inside: bs.every(r => r.left >= 0 && r.right <= innerWidth), rowScroll: document.querySelector('.toolrow').scrollWidth <= Math.ceil(tr.width) }; });
  ok(await noHScroll(a) && row.inside && row.rowScroll && row.n === 8 && row.minW >= 40 && row.minH >= 44, '14 360×740: 8 Knöpfe in der Werkzeugreihe, kein horizontaler Scroll, mindestens 40×44', JSON.stringify(row));
  await a.click('[data-tool="shape"]'); await a.click('#pop-shapes [data-shape="ellipse"]'); await sleep(150);
  { const bx = await box(a); await a.mouse.move(bx.x + 60, bx.y + 100); await a.mouse.down(); await a.mouse.move(bx.x + 300, bx.y + 300, { steps: 5 }); await a.mouse.up(); await sleep(400); }
  await setCol(a, YELLOW);
  await a.click('[data-tool="fill"]'); await sleep(150);
  { const bx = await box(a); await a.mouse.click(bx.x + 180, bx.y + 200); await sleep(500); }
  ok(await cnt(a) === 2 && await noHScroll(a), '14 360: Füllen über den Knopf der Werkzeugreihe', `objekte=${await cnt(a)}`);
  await shot(a, 'fuellen-360.png');
  await sleep(SYNC);
  await count('14 am Ende: 2 Objekte auf beiden', 2);

  // ── 13. Zeitmessung: 1400×900, DPR 2, ~60 Striche ───────────────────────
  const E = await mk('E', { viewport: { width: 1400, height: 900 }, dpr: 2, blockRelay: true, noP2P: true }); const e = E.page;
  await fresh(E); await sleep(1500);
  await shape(e, 'rect', [150, 120], [1250, 760]);
  await key(e, 'p');
  { const bx = await box(e); let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 59; i++) { const x = 200 + rnd() * 950, y = 170 + rnd() * 500, dx = (rnd() - 0.5) * 160, dy = (rnd() - 0.5) * 100; await e.mouse.move(bx.x + x, bx.y + y); await e.mouse.down(); for (let s = 1; s <= 5; s++) await e.mouse.move(bx.x + x + dx * s / 5 + Math.sin(s) * 6, bx.y + y + dy * s / 5 + Math.cos(s) * 6); await e.mouse.up(); } }
  await sleep(1500);
  const nE = await cnt(e);
  await setCol(e, YELLOW); await key(e, 'f');
  const times = [];
  { const s = await scr(e, 170, 140); const t0 = Date.now(); await e.mouse.click(s.x, s.y); const wall = Date.now() - t0; await sleep(400); times.push({ fall: 'füllen (60 Striche, Löcher)', wall, info: (await ovl(e)).fill }); }
  ok(await cnt(e) === nE + 1 && nE === 60, '13 Füllen auf einer Seite mit 60 Strichen (1400×900, DPR 2)', `objekte ${nE} → ${await cnt(e)}`);
  await shot(e, 'fuellen-zeit.png');
  { const s = await scr(e, 60, 60); const t0 = Date.now(); await e.mouse.click(s.x, s.y); const wall = Date.now() - t0; await sleep(400); times.push({ fall: 'offene Fläche (zwei Durchgänge)', wall, info: (await ovl(e)).fill }); }
  { await setCol(e, RED); await key(e, 'f'); const s = await scr(e, 170, 140); const t0 = Date.now(); await e.mouse.click(s.x, s.y); const wall = Date.now() - t0; await sleep(400); times.push({ fall: 'umfärben', wall, info: (await ovl(e)).fill }); }
  // noch dreimal dieselbe Fläche: zurücknehmen und neu füllen (der erste Lauf enthält das Anlaufen des JIT)
  await setCol(e, YELLOW);
  for (let i = 0; i < 3; i++) {
    await key(e, 'v'); await tap(e, 170, 140); await key(e, 'Delete'); await sleep(300); await key(e, 'f');
    const s = await scr(e, 170, 140); const t0 = Date.now(); await e.mouse.click(s.x, s.y); const wall = Date.now() - t0; await sleep(400); times.push({ fall: `füllen, Wiederholung ${i + 1}`, wall, info: (await ovl(e)).fill });
  }
  for (const t of times) console.log(`ZEIT ${t.fall}: ${t.info} — Klick bis Rückkehr ${t.wall} ms`);
  const ms = t => Number((t.info.match(/^(\d+) ms \(ok/) || [])[1]);
  const warm = times.slice(3).map(ms);
  const runs = [ms(times[0]), ...warm].sort((x, y) => x - y);
  ok(runs.every(v => v > 0) && runs[1] < 150, '13 Füllen (Klick bis fertig gezeichnet) unter 150 ms (Median aus 4 Läufen)', `erster Lauf ${ms(times[0])} ms, danach ${warm.join(' / ')} ms`);

  // ── 14b. Touch (eigener Kontext mit hasTouch, Eingabe über CDP) ─────────
  const D = await mk('D', { touch: true, blockRelay: true, noP2P: true }); const d = D.page;
  await fresh(D); await sleep(2000);
  const cdp = await D.ctx.newCDPSession(d);
  const dbox = await box(d);
  const tp = pts => pts.map(([x, y], i) => ({ x: dbox.x + x, y: dbox.y + y, id: i }));
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: tp(pts) });
  const tdrag = async (from, to, steps = 6) => { await touch('touchStart', [from]); for (let i = 1; i <= steps; i++) { await touch('touchMove', [[from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps]]); await sleep(20); } await touch('touchEnd', []); await sleep(300); };
  const ttap = async (x, y) => { await touch('touchStart', [[x, y]]); await sleep(40); await touch('touchEnd', []); await sleep(400); };
  await d.click('[data-tool="shape"]'); await d.click('#pop-shapes [data-shape="rect"]'); await sleep(150);
  await tdrag([200, 200], [400, 320]);
  await d.click('[data-tool="shape"]'); await d.click('#pop-shapes [data-shape="rect"]'); await sleep(150);
  await tdrag([500, 200], [700, 320]);
  await setCol(d, GREEN);
  await d.click('[data-tool="fill"]'); await sleep(150);
  await tdrag([280, 240], [340, 290]);
  ok(await cnt(d) === 2, '14 Touch: Wischen im Füllwerkzeug füllt nicht', `objekte=${await cnt(d)}`);
  await ttap(300, 260);
  ok(await cnt(d) === 3 && (await probe(300, 260, GREEN)(d)) === true && (await probe(300, 200, DARK)(d)) === true, '14 Touch: Tipp mit einem Finger füllt', `objekte=${await cnt(d)}`);
  // Zwei-Finger-Zoom im Bewegen-Modus bleibt
  await d.click('#btn-hand'); await sleep(150);
  const vd0 = (await ovl(d)).view;
  await touch('touchStart', [[300, 400]]); await touch('touchStart', [[300, 400], [500, 400]]);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', [[300 - i * 15, 400], [500 + i * 15, 400]]); await sleep(20); }
  await touch('touchEnd', []); await sleep(500);
  const vd1 = (await ovl(d)).view;
  ok(vd1.k > vd0.k * 1.3 && await cnt(d) === 3, '14 Touch: Zwei-Finger-Zoom im Bewegen-Modus geht weiter (füllt nicht)', `${vd0.k} → ${vd1.k}`);
  await d.click('#btn-hand'); await sleep(150);
  ok(await d.evaluate(() => document.querySelector('[data-tool="fill"]').getAttribute('aria-pressed') === 'true'), '14 Hand aus: zurück im Füllwerkzeug');
  // Nur-Stift-Modus: Finger füllt nicht, Maus schon
  await d.click('#btn-notebooks'); await sleep(300); await d.click('#btn-settings'); await sleep(300);
  await d.evaluate(() => document.getElementById('set-pen-only').click()); await sleep(200);
  for (let i = 0; i < 4; i++) { await d.keyboard.press('Escape'); await sleep(200); }
  await d.click('[data-tool="fill"]'); await sleep(150);
  { const s = await scr(d, 600, 260); const bx = await box(d); await ttap(s.x - bx.x, s.y - bx.y); }
  ok(await cnt(d) === 3, '14 Nur-Stift-Modus: Finger füllt nicht', `objekte=${await cnt(d)}`);
  await tap(d, 600, 260);
  ok(await cnt(d) === 4 && (await probe(600, 260, GREEN)(d)) === true, '14 Nur-Stift-Modus: Maus füllt weiter', `objekte=${await cnt(d)}`);
  await d.evaluate(() => document.getElementById('set-pen-only').click());
  unchecked.push('Stift-Eingabe (pointerType „pen“) lässt sich in Chromium headless nicht erzeugen: Füllen nur über Maus und Touch geprüft');
  unchecked.push('Touch nur über CDP-Emulation (Input.dispatchTouchEvent), nicht auf einem echten Gerät');
  unchecked.push('Zeitmessung nur in Chromium headless auf diesem Rechner, nicht auf einem Tablet/Handy');

  // ── Abschluss: keine nativen Dialoge, keine Konsolenfehler ──────────────
  for (const X of all) {
    ok(X.dialogs.length === 0, `14 kein nativer Dialog (${X.name})`, X.dialogs.join(' | '));
    const bad = X.logs.filter(l => /PAGEERROR|^error|ReferenceError|TypeError|fehlgeschlagen/.test(l) && !/User-Initiated Abort|WebRTC blockiert|Relay blockiert|ERR_CONNECTION|WebSocket/.test(l));
    ok(bad.length === 0, `14 keine Konsolenfehler (${X.name})`, bad.slice(0, 6).join('\n  '));
  }
  if (process.env.LOGS) for (const X of all) console.log(`--- ${X.name}\n` + X.logs.slice(-30).join('\n'));
  for (const u of unchecked) console.log('UNGEPRÜFT ' + u);
  await browser.close();
  console.log(fails ? `ERGEBNIS: ${fails} FEHLER` : 'ERGEBNIS: ALLES OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TESTFEHLER', e); process.exit(2); });
