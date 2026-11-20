// Test Formen + Auswahl: node shapes.cjs <URL>
// Zwei isolierte Kontexte im Geräte-Sync (NO_P2P=1 blockiert WebRTC — der Relay-Live-Weg muss reichen).
// Prüft: Formen aufziehen, Auswahl (verschieben, Größe, Füllung, Farbe), Rückgängig/Wiederholen je
// Änderung, gleichzeitige Änderung (letzter gewinnt), Löschen/Duplizieren, Stiftstrich verschieben,
// Verhalten der Auswahl, Seite leeren, Reload, Vorschau/PNG/SVG, Sicherung, alter Renderer, Touch, 360 px.
// Koordinaten im Test sind Weltkoordinaten; die Ansicht steht in der Overlay-Zeile 'ansicht: scale x y'.
// Endet mit 'ERGEBNIS: ALLES OK' (Exit 0) oder 'ERGEBNIS: n FEHLER' (Exit 1).
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const URL = process.argv[2] || 'https://localhost:4444/app.html';
const OUT = process.env.OUT || '/tmp/notes-ui';
const PASS = 'Formen-Test-Passphrase-1';
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
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, ignoreHTTPSErrors: true, acceptDownloads: true, colorScheme: 'light', hasTouch: !!opts.touch });
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
  const ovl = p => p.evaluate(() => { const t = document.getElementById('console')?.innerText || ''; const m = t.match(/striche: (\d+) \(events: (\d+)\)/); const v = t.match(/ansicht: ([\d.]+) (-?[\d.]+) (-?[\d.]+)/); return { s: m ? Number(m[1]) : -1, e: m ? Number(m[2]) : -1, view: v ? { k: Number(v[1]), x: Number(v[2]), y: Number(v[3]) } : null }; });
  const cnt = async p => (await ovl(p)).s;
  const box = p => p.evaluate(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height }; });
  /** Weltkoordinate → Position im Fenster */
  const scr = async (p, wx, wy) => { const b = await box(p); const v = (await ovl(p)).view; return { x: b.x + wx * v.k + v.x, y: b.y + wy * v.k + v.y }; };
  const drag = async (p, a, b, { shift = false, steps = 8 } = {}) => {
    const s = await scr(p, a[0], a[1]), e = await scr(p, b[0], b[1]);
    if (shift) await p.keyboard.down('Shift');
    await p.mouse.move(s.x, s.y); await p.mouse.down();
    for (let i = 1; i <= steps; i++) await p.mouse.move(s.x + (e.x - s.x) * i / steps, s.y + (e.y - s.y) * i / steps);
    await p.mouse.up();
    if (shift) await p.keyboard.up('Shift');
    await sleep(200);
  };
  const tap = async (p, wx, wy) => { const s = await scr(p, wx, wy); await p.mouse.click(s.x, s.y); await sleep(200); };
  /** Farbe der Strich-Ebene an einer Weltkoordinate: [r,g,b,a] */
  const ink = async (p, wx, wy) => { const v = (await ovl(p)).view; return p.evaluate(([x, y]) => { const c = document.getElementById('static-canvas'); const k = c.width / c.getBoundingClientRect().width; return [...c.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data]; }, [wx * v.k + v.x, wy * v.k + v.y]); };
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const isCol = (px, h, tol = 45) => px[3] > 200 && hex(h).every((c, i) => Math.abs(px[i] - c) <= tol);
  const DARK = '#14171c', RED = '#e03131', YELLOW = '#f2c200', BLUE = '#1971c2';
  const empty = px => px[3] === 0;
  /** Prüft dieselbe Bedingung auf A und B */
  const both = async (label, fn) => { const r = []; for (const X of [A, B]) r.push(await fn(X.page)); ok(r.every(x => x === true), label, r.every(x => x === true) ? '' : `A=${JSON.stringify(r[0])} B=${JSON.stringify(r[1])}`); };
  const probe = (wx, wy, want) => async p => { const px = await ink(p, wx, wy); return (want === null ? empty(px) : isCol(px, want)) || px.join(','); };
  const count = async (label, want) => { const [a, b] = [await cnt(A.page), await cnt(B.page)]; ok(a === want && b === want, label, `A=${a} B=${b} (soll ${want})`); };
  /** Grobes Raster der Strich-Ebene (welche 10-px-Zellen enthalten Farbe) — zum Vergleich zweier Geräte */
  const sig = p => p.evaluate(() => { const c = document.getElementById('static-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const n = 10; let out = '', filled = 0; for (let y = 0; y < c.height; y += n) { for (let x = 0; x < c.width; x += n) { let sum = 0; for (let j = 0; j < n && y + j < c.height; j++) for (let i = 0; i < n && x + i < c.width; i++) { const o = ((y + j) * c.width + x + i) * 4; if (d[o + 3] > 0) sum += d[o] + d[o + 1] * 3 + d[o + 2] * 7 + 1; } out += sum ? (sum % 97).toString(36).padStart(2, '0') : '..'; if (sum) filled++; } } return { out, filled }; });
  const sameSig = async (label) => { await A.page.click('#btn-fit'); await B.page.click('#btn-fit'); await sleep(500); const [a, b] = [await sig(A.page), await sig(B.page)]; ok(a.out === b.out && a.filled > 10, label, `Zellen mit Farbe: A=${a.filled} B=${b.filled}`); return a; };
  const selShown = p => p.evaluate(() => !document.getElementById('selbar').hidden);
  /** Rahmen sichtbar? (Petrol auf der aktiven Fläche) */
  const frameShown = p => p.evaluate(() => { const c = document.querySelectorAll('canvas')[2]; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && Math.abs(d[i] - 11) < 30 && Math.abs(d[i + 1] - 114) < 30 && Math.abs(d[i + 2] - 133) < 30) n++; return n; });
  const tool = async (p, t) => { await p.keyboard.press(t === 'select' ? 'v' : t === 'shape' ? 's' : t === 'pen' ? 'p' : 'e'); await sleep(120); };
  const pickShape = async (p, type) => { await p.click('[data-tool="shape"]'); await p.click(`#pop-shapes [data-shape="${type}"]`); await sleep(120); };
  const reload = async X => { await X.page.reload(); await ready(X.page).catch(() => {}); };
  const reloadBoth = async () => { await Promise.all([reload(A), reload(B)]); await sleep(7000); };
  const undoKey = async p => { await p.keyboard.press('Control+z'); await sleep(1800); };
  const redoKey = async p => { await p.keyboard.press('Control+Shift+Z'); await sleep(1800); };
  const shot = (p, name) => p.screenshot({ path: `${OUT}/${name}` });
  const noHScroll = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);

  // ── Aufbau: zwei Geräte mit demselben Schlüssel ─────────────────────────
  const A = await mk('A'), B = await mk('B');
  await fresh(A); await sleep(3000);
  const keyHex = await A.page.evaluate(() => JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw')).map(b => b.toString(16).padStart(2, '0')).join(''));
  await B.page.goto(URL + '#' + keyHex); await ready(B.page).catch(() => {});
  await sleep(8000);
  const a = A.page, b = B.page;
  if (process.env.NO_P2P) { const p2p = /↳[^;]*connected/.test(await a.evaluate(() => document.getElementById('console').innerText)); ok(!p2p, 'ohne P2P (nur Relay)'); }
  ok(/shapes-v47/.test(await a.evaluate(() => document.getElementById('console').innerText)), 'Version shapes-v47');
  const v0 = [(await ovl(a)).view, (await ovl(b)).view];
  ok(v0.every(v => v && v.k === 1 && v.x === 0 && v.y === 0), 'Ausgangsansicht auf beiden 1:1', JSON.stringify(v0));
  ok(await a.evaluate(() => document.querySelectorAll('canvas')[2]?.id === 'active-canvas'), 'canvas[2] ist die aktive Zeichenfläche');
  ok(await a.evaluate(() => !document.querySelector('[data-tool="fill"]')), 'kein Knopf für das Füllwerkzeug');

  // ── 1. Vier Formen ──────────────────────────────────────────────────────
  await a.click('[data-tool="shape"]'); await sleep(200);
  ok(await a.evaluate(() => !document.getElementById('pop-shapes').hidden && document.querySelectorAll('#pop-shapes [data-shape]').length === 4), '1 Formen-Knopf öffnet die Auswahl mit 4 Formen');
  await shot(a, 'formen-popover.png');
  await a.click('#pop-shapes [data-shape="rect"]'); await sleep(100);
  await drag(a, [100, 100], [250, 200]);
  await pickShape(a, 'ellipse');
  ok(await a.evaluate(() => document.getElementById('shape-icon').getAttribute('href') === '#i-ellipse' && document.querySelector('[data-tool="shape"]').getAttribute('aria-pressed') === 'true'), '1 Knopf zeigt die gewählte Form');
  await drag(a, [320, 100], [470, 200]);
  await pickShape(a, 'line'); await drag(a, [100, 300], [250, 380]);
  await pickShape(a, 'arrow'); await drag(a, [320, 300], [470, 380]);
  // Versehentlicher Tipp: keine Form
  await drag(a, [600, 500], [602, 501], { steps: 2 });
  await sleep(2500);
  await count('1 vier Formen auf A und B (Tipp ohne Ziehen erzeugt nichts)', 4);
  await both('1 Rechteck: Kontur oben und links', async p => (await probe(175, 100, DARK)(p)) === true && (await probe(100, 150, DARK)(p)) === true);
  await both('1 Rechteck: Inneres leer', probe(175, 150, null));
  await both('1 Ellipse: Kontur oben und rechts, Mitte leer', async p => (await probe(395, 100, DARK)(p)) === true && (await probe(470, 150, DARK)(p)) === true && (await probe(395, 150, null)(p)) === true);
  await both('1 Linie: Mitte gefärbt, daneben leer', async p => (await probe(175, 340, DARK)(p)) === true && (await probe(175, 310, null)(p)) === true);
  await both('1 Pfeil: Schaft und Spitze gefärbt', async p => (await probe(395, 340, DARK)(p)) === true && (await probe(468, 379, DARK)(p)) === true && (await probe(462, 368, DARK)(p)) === true);
  await shot(a, 'formen-alle.png');

  // ── 2. Auswahl: verschieben, Größe, Füllung, Farbe ──────────────────────
  await a.click('[data-tool="select"]'); await sleep(150);
  await tap(a, 175, 150);
  ok(!(await selShown(a)), '2 Tipp ins Innere des ungefüllten Rechtecks wählt nichts');
  await tap(a, 175, 100);
  ok(await selShown(a) && await frameShown(a) > 100, '2 Tipp auf die Kontur wählt das Rechteck (Rahmen in Petrol + Leiste)', `petrol=${await frameShown(a)}`);
  ok(await a.evaluate(() => !document.getElementById('sel-fill-wrap').hidden && ['btn-sel-color', 'btn-sel-fill', 'btn-sel-duplicate', 'btn-sel-delete'].every(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.width >= 44 && r.height >= 44; })), '2 Leiste: Farbe, Füllung, Duplizieren, Löschen (≥ 44 px)');
  ok(!(await selShown(b)), '2 Auswahl ist lokal (B zeigt keine)');
  await shot(a, 'auswahl-rechteck.png');
  const ev0 = (await ovl(a)).e;
  await drag(a, [130, 100], [580, 100], { steps: 12 }); // neben dem Griff oben Mitte anfassen await sleep(2500);
  ok((await ovl(a)).e === ev0 + 1, '2 Verschieben erzeugt genau EIN Event', `${ev0} → ${(await ovl(a)).e}`);
  await count('2 nach dem Verschieben weiter 4 Objekte', 4);
  await both('2 Rechteck an neuer Stelle', async p => (await probe(625, 100, DARK)(p)) === true && (await probe(550, 150, DARK)(p)) === true);
  await both('2 alte Stelle leer', async p => (await probe(175, 100, null)(p)) === true && (await probe(100, 150, null)(p)) === true);
  ok(await selShown(a), '2 Auswahl bleibt nach dem Verschieben');
  // Griff unten rechts: Rahmen = Objekt + 8 px
  await drag(a, [708, 208], [788, 268]); await sleep(2500);
  await both('2 Größe geändert: neue rechte und untere Kante', async p => (await probe(780, 180, DARK)(p)) === true && (await probe(660, 260, DARK)(p)) === true);
  await both('2 Größe geändert: alte Kanten leer, linke obere Ecke fest', async p => (await probe(700, 180, null)(p)) === true && (await probe(625, 200, null)(p)) === true && (await probe(550, 150, DARK)(p)) === true && (await probe(625, 100, DARK)(p)) === true);
  await a.click('#btn-sel-fill'); await sleep(200);
  ok(await a.evaluate(() => { const p = document.getElementById('pop-sel-fill'), c = document.getElementById('canvas-container').getBoundingClientRect(), r = p.getBoundingClientRect(); return !p.hidden && !!document.getElementById('btn-sel-nofill') && p.querySelectorAll('.swatch').length >= 9 && r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom; }), '2 Füllung: „Keine“ + Palette, Popover ganz in der Zeichenfläche');
  await shot(a, 'auswahl-leiste-fuellung.png');
  await a.click(`#sel-fill-swatches [data-color="${YELLOW}"]`); await sleep(2500);
  await both('2 Füllung gesetzt: Inneres gelb', probe(660, 180, YELLOW));
  await a.click('#btn-sel-color'); await sleep(200);
  await a.click(`#sel-color-swatches [data-color="${RED}"]`); await sleep(2500);
  await both('2 Farbe geändert: Kontur rot, Füllung bleibt', async p => (await probe(625, 100, RED)(p)) === true && (await probe(660, 180, YELLOW)(p)) === true);
  await count('2 weiter 4 Objekte', 4);
  // Dunkles Theme: Rahmen bleibt Petrol
  await a.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await sleep(300);
  ok(await frameShown(a) > 100, '2 dunkles Theme: Rahmen bleibt Petrol', `petrol=${await frameShown(a)}`);
  await shot(a, 'auswahl-dark.png');
  await a.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await sleep(200);

  // ── 3. Rückgängig / Wiederholen je Änderung ─────────────────────────────
  await undoKey(a);
  await both('3 Strg+Z nimmt nur die Farbe zurück', async p => (await probe(625, 100, DARK)(p)) === true && (await probe(660, 180, YELLOW)(p)) === true);
  await undoKey(a);
  await both('3 Strg+Z: Füllung weg, Größe bleibt', async p => (await probe(660, 180, null)(p)) === true && (await probe(780, 180, DARK)(p)) === true);
  await undoKey(a);
  await both('3 Strg+Z: alte Größe, Position bleibt', async p => (await probe(780, 180, null)(p)) === true && (await probe(700, 150, DARK)(p)) === true && (await probe(625, 200, DARK)(p)) === true);
  await undoKey(a);
  await both('3 Strg+Z: Ausgangslage (Rechteck wieder links)', async p => (await probe(175, 100, DARK)(p)) === true && (await probe(625, 100, null)(p)) === true && (await probe(175, 150, null)(p)) === true);
  await count('3 nach viermal Rückgängig weiter 4 Objekte', 4);
  ok(await a.evaluate(() => !document.getElementById('btn-redo').disabled) && await b.evaluate(() => document.getElementById('btn-redo').disabled), '3 Redo-Knopf: bei A aktiv, bei B nicht');
  await redoKey(a);
  await both('3 Wiederholen: verschoben', async p => (await probe(625, 100, DARK)(p)) === true && (await probe(175, 100, null)(p)) === true && (await probe(780, 180, null)(p)) === true);
  await redoKey(a);
  await both('3 Wiederholen: Größe', async p => (await probe(780, 180, DARK)(p)) === true && (await probe(660, 180, null)(p)) === true);
  await redoKey(a);
  await both('3 Wiederholen: Füllung', async p => (await probe(660, 180, YELLOW)(p)) === true && (await probe(625, 100, DARK)(p)) === true);
  await redoKey(a);
  await both('3 Wiederholen: Farbe', async p => (await probe(625, 100, RED)(p)) === true && (await probe(660, 180, YELLOW)(p)) === true);
  ok(await a.evaluate(() => document.getElementById('btn-redo').disabled), '3 Redo-Stapel danach leer');
  // Pfeiltasten: mehrere Schritte = EIN edit
  const ev1 = (await ovl(a)).e;
  for (let i = 0; i < 2; i++) await a.keyboard.press('Shift+ArrowDown');
  for (let i = 0; i < 5; i++) await a.keyboard.press('ArrowDown');
  await sleep(2800);
  ok((await ovl(a)).e === ev1 + 1, '3 Pfeiltasten: 7 Tastendrücke = EIN Event', `${ev1} → ${(await ovl(a)).e}`);
  await both('3 Pfeiltasten: 25 px nach unten (2× Umschalt = 20, 5× 1)', async p => (await probe(625, 125, RED)(p)) === true && (await probe(625, 100, null)(p)) === true);
  await undoKey(a);
  await both('3 Strg+Z nimmt das Schieben als Ganzes zurück', probe(625, 100, RED));

  // ── 4. Gleichzeitige Änderung: letzter gewinnt ──────────────────────────
  await b.click('[data-tool="select"]'); await sleep(150);
  // B greift die Ellipse zuerst und hält; A verschiebt sie inzwischen fertig; dann lässt B los.
  const bs = await scr(b, 395, 100);
  await b.mouse.move(bs.x, bs.y); await b.mouse.down(); await b.mouse.move(bs.x + 60, bs.y + 60, { steps: 4 });
  await drag(a, [395, 100], [395, 420]); await sleep(1500);
  ok((await probe(395, 420, DARK)(a)) === true, '4 A hat die Ellipse nach unten geschoben');
  ok((await probe(455, 160, DARK)(b)) === true && (await probe(395, 420, null)(b)) === true, '4 solange B zieht, gewinnt bei B die lokale Vorschau');
  await b.mouse.move(bs.x + 330, bs.y + 300, { steps: 6 }); await b.mouse.up();
  await sleep(3000);
  await both('4 beide zeigen denselben Zustand: Ellipse dort, wo B sie losließ', async p => (await probe(725, 400, DARK)(p)) === true && (await probe(395, 420, null)(p)) === true && (await probe(395, 100, null)(p)) === true);
  await count('4 weiter 4 Objekte', 4);
  ok(await selShown(b) && await selShown(a), '4 A hatte die Ellipse ausgewählt — der Rahmen bleibt, obwohl B sie verschoben hat');
  ok(await a.evaluate(() => { const bar = document.getElementById('selbar').getBoundingClientRect(); return bar.left > 550; }), '4 Rahmen/Leiste von A folgen der Änderung von B', JSON.stringify(await a.evaluate(() => { const r = document.getElementById('selbar').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })));
  await reloadBoth();
  await count('4 nach Reload beider: 4 Objekte', 4);
  await sameSig('4 nach Reload beider: identisches Bild auf A und B');
  await both('4 nach Reload: Ellipse an der Stelle von B, Rechteck rot/gelb', async p => (await probe(725, 400, DARK)(p)) === true && (await probe(395, 420, null)(p)) === true && (await probe(625, 100, RED)(p)) === true && (await probe(660, 180, YELLOW)(p)) === true);

  // ── 5. Löschen, Rückgängig, Duplizieren ─────────────────────────────────
  await tool(a, 'select');
  await tap(a, 660, 180); // gefüllt: Fläche zählt
  ok(await selShown(a), '5 gefülltes Rechteck über die Fläche wählbar');
  await a.click('#btn-sel-delete'); await sleep(2500);
  await count('5 Löschen über die Leiste: 3 Objekte', 3);
  ok(!(await selShown(a)) && await a.evaluate(() => [...document.querySelectorAll('#toasts .toast')].some(t => /gelöscht/.test(t.textContent) && /Rückgängig/.test(t.textContent))), '5 Auswahl weg, Hinweis mit „Rückgängig“');
  await both('5 Rechteck weg', probe(660, 180, null));
  await undoKey(a); await sleep(800);
  await count('5 Strg+Z holt das gelöschte Objekt zurück: 4', 4);
  await both('5 Rechteck wieder da (rot/gelb)', async p => (await probe(625, 100, RED)(p)) === true && (await probe(660, 180, YELLOW)(p)) === true);
  await redoKey(a);
  await count('5 Wiederholen löscht erneut: 3', 3);
  await undoKey(a);
  await count('5 Strg+Z: wieder 4', 4);
  await tap(a, 660, 180);
  await a.click('#btn-sel-duplicate'); await sleep(2500);
  await count('5 Duplizieren: 5 Objekte', 5);
  ok(await selShown(a), '5 die Kopie ist ausgewählt');

  // ── 9. Reload mitten im Zustand ─────────────────────────────────────────
  const before = await sameSig('9 vor dem Reload: identisches Bild auf A und B');
  await reloadBoth();
  await count('9 nach Reload beider: 5 Objekte', 5);
  const after = await sameSig('9 nach dem Reload: identisches Bild auf A und B');
  ok(before.out === after.out, '9 Bild nach dem Reload wie davor');

  // ── 5b. Entf-Taste ──────────────────────────────────────────────────────
  await tool(a, 'select');
  const vA = (await ovl(a)).view; const off = Math.round(160 / vA.k) / 10;
  await tap(a, 660 + off + 40, 180 + off + 40); // nur die Kopie liegt hier ganz oben
  ok(await selShown(a), '5 Kopie ausgewählt (versetzt um 16 px am Bildschirm)', `versatz=${off}`);
  await a.keyboard.press('Delete'); await sleep(2500);
  await count('5 Entf löscht die Auswahl: 4', 4);
  await both('5 Original steht noch', probe(625, 100, RED));

  // ── 6. Stiftstrich auswählen und verschieben ────────────────────────────
  await tool(a, 'pen');
  await drag(a, [100, 460], [260, 460], { steps: 16 }); await sleep(600);
  await tool(a, 'select');
  await tap(a, 180, 461);
  ok(await selShown(a) && await a.evaluate(() => document.getElementById('sel-fill-wrap').hidden), '6 Stiftstrich wählbar; ohne Knopf „Füllung“');
  await drag(a, [140, 460], [140, 520]); await sleep(2500);
  await count('6 Stiftstrich: 5 Objekte', 5);
  await both('6 Stiftstrich verschoben', async p => (await probe(180, 520, DARK)(p)) === true && (await probe(180, 460, null)(p)) === true);
  await a.click('#btn-sel-color'); await sleep(150); await a.click(`#sel-color-swatches [data-color="${BLUE}"]`); await sleep(2000);
  await both('6 Stiftstrich umgefärbt', probe(180, 520, BLUE));

  // ── 7. Verhalten der Auswahl ────────────────────────────────────────────
  ok(await selShown(a), '7 Stiftstrich ist noch ausgewählt');
  await a.keyboard.press('Escape'); await sleep(200);
  ok(!(await selShown(a)) && await frameShown(a) === 0, '7 Esc hebt die Auswahl auf');
  await tap(a, 180, 520); ok(await selShown(a), '7 erneut ausgewählt');
  await tap(a, 900, 300); ok(!(await selShown(a)), '7 Tipp ins Leere hebt die Auswahl auf');
  await tap(a, 180, 520);
  await a.click('#btn-add-page'); await sleep(1200);
  ok(!(await selShown(a)) && await frameShown(a) === 0, '7 Seitenwechsel: Auswahl weg');
  await a.click('#btn-prev'); await sleep(1500);
  ok(!(await selShown(a)), '7 zurück auf der Seite: keine Auswahl');
  await tool(a, 'select'); await tap(a, 180, 520); ok(await selShown(a), '7 A wählt den Stiftstrich');
  await tool(a, 'pen'); await sleep(150);
  ok(!(await selShown(a)), '7 Werkzeugwechsel: Auswahl weg');
  await tool(a, 'select'); await tap(a, 180, 520);
  await a.click('#btn-hand'); await sleep(150);
  ok(await selShown(a), '7 Hand-Schalter lässt die Auswahl stehen');
  const barBefore = await a.evaluate(() => document.getElementById('selbar').getBoundingClientRect().left);
  const hs = await scr(a, 900, 300);
  await a.mouse.move(hs.x, hs.y); await a.mouse.down(); await a.mouse.move(hs.x - 80, hs.y, { steps: 4 }); await a.mouse.up(); await sleep(300);
  const barAfter = await a.evaluate(() => document.getElementById('selbar').getBoundingClientRect().left);
  ok(Math.abs(barBefore - barAfter - 80) < 3, '7 Auswahl folgt dem Verschieben der Ansicht', `${Math.round(barBefore)} → ${Math.round(barAfter)}`);
  await a.click('#btn-hand'); await sleep(150);
  // B löscht das bei A ausgewählte Objekt
  await tool(b, 'select'); await tap(b, 180, 520);
  ok(await selShown(b), '7 B wählt denselben Strich');
  await b.keyboard.press('Delete'); await sleep(2500);
  ok(!(await selShown(a)) && await frameShown(a) === 0, '7 B löscht das Objekt: Auswahl bei A verschwindet');
  await count('7 danach 4 Objekte', 4);
  // Radierer-Strich ist nicht wählbar
  await tool(a, 'eraser'); await drag(a, [100, 600], [260, 600], { steps: 10 }); await sleep(400);
  await tool(a, 'select'); await tap(a, 180, 600);
  ok(!(await selShown(a)), '7 Radierer-Strich ist nicht wählbar');
  await sleep(2000);
  await count('7 Radierer-Strich zählt als Strich: 5', 5);
  // Radierer wirkt auch auf Formen
  await tool(a, 'eraser'); await drag(a, [625, 80], [625, 130], { steps: 6 }); await sleep(2500);
  await both('7 Radierer wirkt auf die Kontur einer Form', probe(625, 100, null));

  // ── 10. Vorschau, PNG, SVG (nach Reload: aus dem Speicher) ──────────────
  await reloadBoth();
  await count('10 nach Reload: 6 Einträge (4 Objekte + 2 Radierer)', 6);
  await a.click('#btn-page-overview'); await sleep(2500);
  const thumb = await a.evaluate(() => { const c = document.querySelector('#pages-grid .thumb.current canvas') || document.querySelector('#pages-grid .thumb[data-page] canvas'); if (!c) return null; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let dark = 0, yellow = 0, red = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++; if (d[i] > 200 && d[i + 1] > 160 && d[i + 2] < 90) yellow++; if (d[i] > 180 && d[i + 1] < 110 && d[i + 2] < 110) red++; } return { dark, yellow, red }; });
  ok(thumb && thumb.dark > 20 && thumb.yellow > 50 && thumb.red > 5, '10 Vorschaubild enthält Formen (dunkel, gelbe Füllung, rote Kontur)', JSON.stringify(thumb));
  await a.keyboard.press('Escape'); await sleep(300);
  const dl = async (btn, file) => { await a.click('#btn-page-menu'); const [d] = await Promise.all([a.waitForEvent('download', { timeout: 20000 }), a.click(btn)]); await d.saveAs(file); return file; };
  const pngFile = await dl('#btn-menu-export-png', `${OUT}/formen-export.png`);
  const png = await a.evaluate(async b64 => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let dark = 0, yellow = 0, red = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) dark++; if (d[i] > 220 && d[i + 1] > 170 && d[i + 2] < 60) yellow++; if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] < 80) red++; } return { w: img.width, h: img.height, dark, yellow, red }; }, fs.readFileSync(pngFile).toString('base64'));
  ok(png.dark > 500 && png.yellow > 5000 && png.red > 200, '10 PNG-Export enthält Formen mit Füllung', JSON.stringify(png));
  const svg = fs.readFileSync(await dl('#btn-menu-export-svg', `${OUT}/formen-export.svg`), 'utf8');
  const svgN = { rect: (svg.match(/<rect x="/g) || []).length, ellipse: (svg.match(/<ellipse /g) || []).length, line: (svg.match(/<line [^>]*stroke-linecap="round"/g) || []).length, arrow: (svg.match(/<path d="M [^"]* M [^"]*"/g) || []).length, fill: (svg.match(/<rect x="[^>]*fill="#f2c200"/g) || []).length, mask: /<mask id="eraser-mask">/.test(svg) };
  ok(svgN.rect === 1 && svgN.ellipse === 1 && svgN.line === 1 && svgN.arrow === 1 && svgN.fill === 1 && svgN.mask, '10 SVG-Export: je ein <rect>, <ellipse>, <line>, Pfeil-<path>; Rechteck gefüllt', JSON.stringify(svgN));

  // ── 11. Sicherung: exportieren, in frischem Kontext einspielen ──────────
  const sigA = (await sameSig('11 vor der Sicherung: identisches Bild auf A und B')).out;
  await a.click('#btn-notebooks'); await sleep(300); await a.click('#btn-settings'); await sleep(300); await a.click('#set-tab-data'); await sleep(300);
  await a.click('#btn-export-enc'); await a.waitForSelector('#backup-export-modal:not(.hidden)');
  await a.fill('#export-pass', PASS); await a.fill('#export-pass2', PASS);
  const [bk] = await Promise.all([a.waitForEvent('download', { timeout: 30000 }), a.click('#export-ok')]);
  const BK = `${OUT}/formen-backup.enc`; await bk.saveAs(BK); await sleep(500);
  for (let i = 0; i < 4; i++) { await a.keyboard.press('Escape'); await sleep(200); }
  const C = await mk('C', { blockRelay: true, noP2P: true }); const c = C.page;
  await c.goto(URL); await c.waitForSelector('#firststart-modal:not(.hidden)');
  const [chooser] = await Promise.all([c.waitForEvent('filechooser', { timeout: 10000 }), c.click('#btn-restore-backup')]); await chooser.setFiles(BK);
  await c.waitForSelector('#prompt-modal:not(.hidden)', { timeout: 8000 }).catch(() => {});
  await c.fill('#prompt-input', PASS); await c.keyboard.press('Enter');
  await c.waitForFunction(h => localStorage.getItem('notizbuch:masterKeyHash') === h, await a.evaluate(() => localStorage.getItem('notizbuch:masterKeyHash')), { timeout: 20000 }).catch(() => {});
  await ready(c).catch(() => {}); await sleep(3000);
  // C landet evtl. auf einer anderen Seite: auf Seite 1 gehen
  for (let i = 0; i < 5 && !/^1 \//.test(await c.evaluate(() => document.getElementById('page-indicator').textContent.trim())); i++) { await c.click('#btn-prev'); await sleep(600); }
  for (let i = 0; i < 5 && !/^1 \//.test(await a.evaluate(() => document.getElementById('page-indicator').textContent.trim())); i++) { await a.click('#btn-prev'); await sleep(600); }
  await c.click('#btn-fit'); await a.click('#btn-fit'); await sleep(600);
  const [oa, oc] = [await ovl(a), await ovl(c)];
  ok(oc.s === 6 && oc.e === oa.e, '11 eingespielte Sicherung (Relay blockiert): gleiche Objekt- und Event-Zahl', `A=${oa.s}/${oa.e} C=${oc.s}/${oc.e}`);
  ok((await sig(c)).out === (await sig(a)).out && (await sig(a)).out === sigA, '11 eingespielte Sicherung: identisches Bild (Formen, Positionen, Farben, Füllung)');
  ok((await probe(660, 180, YELLOW)(c)) === true && (await probe(725, 400, DARK)(c)) === true, '11 C: Rechteck gefüllt, Ellipse an der verschobenen Stelle');

  // ── 8. Seite leeren ─────────────────────────────────────────────────────
  await tool(a, 'select'); await tap(a, 660, 180);
  await a.click('#btn-page-menu'); await a.click('#btn-clear'); await sleep(400);
  ok(!(await selShown(a)), '8 Seite leeren: Auswahl weg');
  await sleep(8500);
  await count('8 Seite geleert (Hinweis abgelaufen): 0 auf beiden', 0);
  await reloadBoth();
  await count('8 nach Reload beider: 0', 0);
  await pickShape(a, 'ellipse'); await drag(a, [200, 200], [400, 320]); await sleep(2500);
  await count('8 neue Form nach dem Leeren: 1', 1);
  await both('8 neue Ellipse sichtbar', probe(300, 200, DARK));
  await undoKey(a); await count('8 Strg+Z nimmt die Form zurück: 0', 0);
  await redoKey(a); await count('8 Wiederholen: 1', 1);

  // ── 12. Altgerät: stroke-Event mit tool:'shape' durch den alten Renderer ─
  let oldSrc = '';
  try { oldSrc = execSync(`git show ${OLD_COMMIT}:js/canvas.js`, { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8' }); } catch (e) { oldSrc = ''; }
  if (!oldSrc) { ok(false, `12 alter Renderer (${OLD_COMMIT}:js/canvas.js) nicht lesbar`); }
  else {
    await a.addScriptTag({ content: `window.__oldCanvas = (function(){ ${oldSrc.replace(/^export /gm, '')}\n return { drawStrokeToCanvas }; })();` });
    const old = await a.evaluate(async () => {
      const m = await import('./js/canvas.js');
      const mkStroke = (type, x1, y1, x2, y2, size) => { const shape = m.roundShape({ type, x1, y1, x2, y2 }); return { id: type, createdAt: 1, tool: 'shape', shape, fill: null, color: '#14171c', size, points: m.shapeOutlinePoints(shape, size) }; };
      const strokes = [mkStroke('rect', 30, 30, 230, 150, 4), mkStroke('ellipse', 270, 30, 470, 150, 4), mkStroke('line', 30, 200, 230, 270, 4), mkStroke('arrow', 270, 200, 470, 270, 4), mkStroke('rect', 30, 310, 130, 380, 16), mkStroke('arrow', 270, 320, 470, 370, 16), mkStroke('ellipse', 160, 310, 240, 380, 1)];
      const render = fn => { const c = document.createElement('canvas'); c.width = 500; c.height = 410; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 500, 410); let err = ''; try { for (const s of strokes) fn(x, s); } catch (e) { err = String(e); } const d = x.getImageData(0, 0, 500, 410).data; let ink = 0; const at = (px, py) => d[(py * 500 + px) * 4] < 128; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) ink++; return { err, ink, url: c.toDataURL('image/png'), top: at(130, 30), inside: at(130, 90), corner: at(230, 30), outsideCorner: at(238, 22), ell: at(370, 30), line: at(130, 235), tip: at(468, 269), pts: strokes.map(s => s.points.length) }; };
      // Weicht der alte Umriss stark vom neuen Vektor ab? (Anteil der alten Farbpixel, die nahe an neuen liegen)
      return { old: render(window.__oldCanvas.drawStrokeToCanvas), neu: render(m.drawStrokeToCanvas) };
    });
    fs.writeFileSync(`${OUT}/altgeraet-formen.png`, Buffer.from(old.old.url.split(',')[1], 'base64'));
    fs.writeFileSync(`${OUT}/altgeraet-formen-neu.png`, Buffer.from(old.neu.url.split(',')[1], 'base64'));
    ok(old.old.err === '' && old.old.ink > 3000, '12 alter Renderer wirft nicht und zeichnet die Formen als Umriss', `err=${old.old.err} ink=${old.old.ink} punkte=${old.old.pts.join('/')}`);
    ok(old.old.top && !old.old.inside && old.old.corner && !old.old.outsideCorner && old.old.ell && old.old.line && old.old.tip, '12 alter Renderer: Kontur da, Inneres leer, Ecke scharf (kein Ausbeulen)', JSON.stringify({ top: old.old.top, inside: old.old.inside, corner: old.old.corner, outsideCorner: old.old.outsideCorner, ell: old.old.ell, line: old.old.line, tip: old.old.tip }));
    ok(Math.abs(old.old.ink - old.neu.ink) / old.neu.ink < 0.25, '12 alter Umriss deckt etwa dieselbe Fläche wie die neue Vektorform', `alt=${old.old.ink} neu=${old.neu.ink}`);
  }

  // ── 14. 360 × 740 ───────────────────────────────────────────────────────
  await a.setViewportSize({ width: 360, height: 740 }); await sleep(800);
  await a.click('#btn-fit'); await sleep(400);
  const row = await a.evaluate(() => { const bs = [...document.querySelectorAll('.toolrow button.tool, .toolrow button.opt, .toolrow button.mode')].map(e => e.getBoundingClientRect()); const tr = document.querySelector('.toolrow').getBoundingClientRect(); return { n: bs.length, minW: Math.min(...bs.map(r => r.width)), minH: Math.min(...bs.map(r => r.height)), inside: bs.every(r => r.left >= 0 && r.right <= innerWidth), rowScroll: document.querySelector('.toolrow').scrollWidth <= Math.ceil(tr.width) }; });
  ok(await noHScroll(a) && row.inside && row.rowScroll && row.n === 7 && row.minW >= 40 && row.minH >= 44, '14 360×740: 7 Knöpfe in der Werkzeugreihe, kein horizontaler Scroll, mindestens 40×44', JSON.stringify(row));
  await a.click('[data-tool="shape"]'); await sleep(250);
  ok(await a.evaluate(() => { const r = document.getElementById('pop-shapes').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= document.querySelector('.toolrow').getBoundingClientRect().top; }), '14 360: Formen-Auswahl ganz im Bild, über der Werkzeugreihe');
  await shot(a, 'formen-360.png');
  await a.click('#pop-shapes [data-shape="rect"]'); await sleep(150);
  { const bx = await box(a); await a.mouse.move(bx.x + 40, bx.y + 60); await a.mouse.down(); await a.mouse.move(bx.x + 140, bx.y + 140, { steps: 5 }); await a.mouse.up(); await sleep(600); }
  await a.click('[data-tool="select"]'); await sleep(150);
  { const bx = await box(a); await a.mouse.click(bx.x + 90, bx.y + 60); await sleep(300); }
  ok(await selShown(a) && await a.evaluate(() => { const r = document.getElementById('selbar').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }) && await noHScroll(a), '14 360: Auswahl mit Leiste im Bild, kein horizontaler Scroll');
  await a.click('#btn-sel-fill'); await sleep(250);
  ok(await a.evaluate(() => { const r = document.getElementById('pop-sel-fill').getBoundingClientRect(); const c = document.getElementById('canvas-container').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= c.top && r.bottom <= c.bottom; }) && await noHScroll(a), '14 360: Füllungs-Popover ganz im Bild');
  await shot(a, 'auswahl-360.png');
  await a.keyboard.press('Escape'); await sleep(200);
  await sleep(2000);
  await count('14 am Ende: 2 Objekte auf beiden', 2);

  // ── 13. Touch (eigener Kontext mit hasTouch, Eingabe über CDP) ──────────
  const D = await mk('D', { touch: true, blockRelay: true, noP2P: true }); const d = D.page;
  await fresh(D); await sleep(2000);
  const cdp = await D.ctx.newCDPSession(d);
  const dbox = await box(d);
  const tp = pts => pts.map(([x, y], i) => ({ x: dbox.x + x, y: dbox.y + y, id: i }));
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: tp(pts) });
  const tdrag = async (from, to, steps = 6) => { await touch('touchStart', [from]); for (let i = 1; i <= steps; i++) { await touch('touchMove', [[from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps]]); await sleep(20); } await touch('touchEnd', []); await sleep(300); };
  const ttap = async (x, y) => { await touch('touchStart', [[x, y]]); await sleep(40); await touch('touchEnd', []); await sleep(300); };
  await d.click('[data-tool="shape"]'); await d.click('#pop-shapes [data-shape="rect"]'); await sleep(150);
  await tdrag([200, 200], [400, 320]);
  ok(await cnt(d) === 1 && (await probe(300, 200, DARK)(d)) === true && (await probe(300, 260, null)(d)) === true, '13 Touch: Form mit einem Finger aufgezogen', `objekte=${await cnt(d)}`);
  await d.click('[data-tool="select"]'); await sleep(150);
  await ttap(300, 214); // 14 px neben der Kontur: großzügige Toleranz bei Touch
  ok(await selShown(d), '13 Touch: Objekt antippen wählt es (14 px neben der Linie)');
  await tdrag([250, 200], [250, 300]); // neben dem Griff oben Mitte
  ok((await probe(300, 300, DARK)(d)) === true && (await probe(300, 200, null)(d)) === true && await cnt(d) === 1, '13 Touch: Objekt mit dem Finger verschoben');
  // Griff unten rechts (Rahmen bei 408/428): 18 px daneben ansetzen
  await tdrag([424, 440], [484, 500]);
  ok((await probe(460, 400, DARK)(d)) === true && (await probe(400, 400, null)(d)) === true, '13 Touch: Größe über einen Griff geändert (Ansatz 18 px neben dem Griff)');
  // Zwei-Finger-Zoom im Bewegen-Modus
  await d.click('#btn-hand'); await sleep(150);
  const vd0 = (await ovl(d)).view;
  await touch('touchStart', [[300, 300]]); await touch('touchStart', [[300, 300], [500, 300]]);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', [[300 - i * 15, 300], [500 + i * 15, 300]]); await sleep(20); }
  await touch('touchEnd', []); await sleep(500);
  const vd1 = (await ovl(d)).view;
  ok(vd1.k > vd0.k * 1.3, '13 Touch: Zwei-Finger-Zoom im Bewegen-Modus geht weiter', `${vd0.k} → ${vd1.k}`);
  ok(await selShown(d), '13 Touch: Auswahl bleibt beim Zoomen stehen');
  await d.click('#btn-hand'); await sleep(150);
  // Nur-Stift-Modus: Finger zeichnet keine Form
  await d.click('#btn-notebooks'); await sleep(300); await d.click('#btn-settings'); await sleep(300);
  await d.evaluate(() => document.getElementById('set-pen-only').click()); await sleep(200);
  for (let i = 0; i < 4; i++) { await d.keyboard.press('Escape'); await sleep(200); }
  await d.click('[data-tool="shape"]'); await d.keyboard.press('Escape'); await sleep(150);
  await d.click('#btn-fit'); await sleep(300);
  const nBefore = await cnt(d);
  await tdrag([100, 100], [200, 180]);
  ok(await cnt(d) === nBefore, '13 Nur-Stift-Modus: Finger zieht keine Form auf', `${nBefore} → ${await cnt(d)}`);
  { const bx = await box(d); await d.mouse.move(bx.x + 100, bx.y + 500); await d.mouse.down(); await d.mouse.move(bx.x + 200, bx.y + 560, { steps: 4 }); await d.mouse.up(); await sleep(400); }
  ok(await cnt(d) === nBefore + 1, '13 Nur-Stift-Modus: Maus zieht weiter Formen auf');
  // Umschalt: Quadrat
  await d.evaluate(() => document.getElementById('set-pen-only').click());
  unchecked.push('Stift-Eingabe (pointerType „pen“) lässt sich in Chromium headless nicht erzeugen: „Stift zeichnet“ mit Formen/Auswahl nur über Maus und Touch geprüft');
  unchecked.push('Touch nur über CDP-Emulation (Input.dispatchTouchEvent), nicht auf einem echten Gerät; Handballen-Verhalten ungeprüft');

  // ── Umschalt hält Proportionen (auf A, wieder 1200 breit) ───────────────
  await a.setViewportSize({ width: 1200, height: 800 }); await sleep(600);
  await a.click('[data-tool="shape"]'); await a.click('#pop-shapes [data-shape="rect"]'); await sleep(150);
  const vq = (await ovl(a)).view; const w = (sx, sy) => [(sx - vq.x) / vq.k, (sy - vq.y) / vq.k];
  const q0 = w(700, 100), q1 = w(900, 160), qb = w(800, 300), qn = w(800, 160);
  await drag(a, q0, q1, { shift: true }); await sleep(500);
  ok((await probe(qb[0], qb[1], DARK)(a)) === true && (await probe(qn[0], qn[1], null)(a)) === true, 'Umschalt beim Aufziehen: Quadrat (200×200 statt 200×60)');

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
