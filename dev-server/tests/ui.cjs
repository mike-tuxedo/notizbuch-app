// UI-Test Hauptansicht (Redesign Teil A): node ui.cjs <URL>
// Ein Browser-Kontext. Prüft Werkzeugleiste, Popover, Seiten-Pille, Hinweis „Weiterer Inhalt“,
// Theme und Breiten; schreibt Screenshots nach /tmp/notes-ui/.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('fs');
const URL = process.argv[2] || 'https://localhost:4444/app.html';
const OUT = process.env.OUT || '/tmp/notes-ui';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (cond, label, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${extra !== '' ? ' — ' + extra : ''}`); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true, colorScheme: 'light' });
  if (process.env.NO_P2P) await ctx.addInitScript(() => { RTCPeerConnection.prototype.setRemoteDescription = () => Promise.reject(new Error('WebRTC blockiert (Test)')); });
  const page = await ctx.newPage(); const logs = [];
  page.on('console', m => { const t = m.text(); if (!/WebSocket connection|willReadFrequently|Password field/.test(t)) logs.push(`${m.type()}: ${t.slice(0, 220)}`); });
  page.on('pageerror', e => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
  const shot = name => page.screenshot({ path: `${OUT}/${name}` });
  const ready = () => page.waitForFunction(() => (document.getElementById('notebook-title')?.textContent || '').length > 0 && document.getElementById('active-canvas')?.width > 0, null, { timeout: 20000 });
  const $ = (fn, arg) => page.evaluate(fn, arg);
  const visible = sel => $(s => { const e = document.querySelector(s); return !!e && !e.hidden && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; }, sel);
  const attr = (sel, a) => $(([s, a]) => document.querySelector(s)?.getAttribute(a), [sel, a]);
  const cbox = () => $(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height }; });
  // Anzahl nicht-transparenter Pixel auf der Strich-Fläche (= sichtbare Tinte)
  const ink = () => $(() => { const c = document.getElementById('static-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  const pixel = (x, y) => $(([x, y]) => { const c = document.getElementById('static-canvas'); const k = c.width / c.clientWidth; return [...c.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data]; }, [x, y]);
  const drag = async (x0, y0, x1, y1) => { const b = await cbox(); await page.mouse.move(b.x + x0, b.y + y0); await page.mouse.down(); for (let i = 1; i <= 20; i++) await page.mouse.move(b.x + x0 + (x1 - x0) * i / 20, b.y + y0 + (y1 - y0) * i / 20); await page.mouse.up(); };
  const noHScroll = async label => { const r = await $(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, out: [...document.querySelectorAll('.main button, .main .float')].filter(e => { if (e.hidden || !e.getClientRects().length || e.closest('[hidden]')) return false; const b = e.getBoundingClientRect(); return b.right > innerWidth + 0.5 || b.left < -0.5; }).map(e => e.id || e.className) })); ok(r.sw <= r.iw && r.out.length === 0, `${label}: kein horizontaler Scroll`, `scrollWidth=${r.sw} innerWidth=${r.iw}${r.out.length ? ' außerhalb: ' + r.out.join(',') : ''}`); };

  // ── Erststart ──────────────────────────────────────────────────────────
  await page.goto(URL);
  const themeEarly = await $(() => document.documentElement.dataset.theme);
  ok(themeEarly === 'light', 'Theme folgt beim Start dem System (hell)', themeEarly);
  await page.click('#btn-new-start'); await page.click('#btn-key-confirmed'); await ready(); await sleep(1500);
  ok(await $(() => document.querySelectorAll('canvas')[2]?.id === 'active-canvas'), 'canvas[2] ist die aktive Zeichenfläche');
  ok(await $(() => !document.getElementById('btn-add-testbook')), 'Testbuch-Knopf entfernt');
  ok(await $(() => ['pen', 'eraser', 'fill', 'shape', 'select'].every(t => !!document.querySelector(`.toolrow [data-tool="${t}"]`)) && document.querySelectorAll('.toolrow [data-tool]').length === 5), 'Werkzeuge Stift, Radierer, Füllen, Formen, Auswahl vorhanden');
  await page.keyboard.press('f'); await sleep(150);
  ok(await $(() => document.querySelector('[data-tool="fill"]').getAttribute('aria-pressed') === 'true' && /\(F\)/.test(document.querySelector('[data-tool="fill"]').title)), '„Füllen“ ist keine Attrappe: Taste F wählt das Werkzeug');
  await page.keyboard.press('p'); await sleep(150);
  ok(await $(() => !document.querySelector('[data-color="#ffffff"]')), 'Weiß nicht in der Palette');
  ok(await $(() => [...document.querySelectorAll('.main button')].every(b => b.getAttribute('aria-label') || b.title || b.textContent.trim())), 'alle Knöpfe der Hauptansicht haben aria-label/title');

  // ── Strich zeichnen ────────────────────────────────────────────────────
  ok(await ink() === 0, 'leere Seite hat keine Tinte');
  await drag(300, 300, 600, 300); await sleep(600);
  const ink1 = await ink();
  ok(ink1 > 0, 'Strich gezeichnet', `Pixel=${ink1}`);
  ok(await visible('button[title="Rückgängig"]') && await visible('#btn-redo'), 'Undo und Redo sichtbar');

  // ── Hand-Schalter ──────────────────────────────────────────────────────
  const mode = () => $(() => ({ mode: document.getElementById('main').dataset.mode, hand: document.getElementById('btn-hand').getAttribute('aria-pressed'), pen: document.querySelector('[data-tool="pen"]').getAttribute('aria-pressed'), eraser: document.querySelector('[data-tool="eraser"]').getAttribute('aria-pressed'), cursor: document.getElementById('canvas-container').style.cursor }));
  let m = await mode();
  ok(m.mode === 'draw' && m.hand === 'false' && m.pen === 'true', 'Start: Stift aktiv, Hand aus', JSON.stringify(m));
  await page.click('#btn-hand'); m = await mode();
  ok(m.mode === 'move' && m.hand === 'true', 'Hand an → bewegen', JSON.stringify(m));
  await drag(300, 500, 500, 500); await sleep(300);
  ok(await ink() === ink1, 'Hand an: Ziehen zeichnet nicht', `Pixel=${await ink()}`);
  await drag(500, 500, 300, 500);
  await page.click('#btn-hand'); m = await mode();
  ok(m.mode === 'draw' && m.hand === 'false' && m.pen === 'true' && m.cursor === 'crosshair', 'Hand aus → zurück zum Stift', JSON.stringify(m));
  await page.click('[data-tool="eraser"]'); m = await mode();
  ok(m.eraser === 'true' && m.cursor === 'cell', 'Radierer gewählt', JSON.stringify(m));
  await page.click('#btn-hand'); await page.click('#btn-hand'); m = await mode();
  ok(m.mode === 'draw' && m.eraser === 'true' && m.pen === 'false' && m.cursor === 'cell', 'Hand an/aus nach Radierer → Radierer kommt zurück', JSON.stringify(m));
  await page.click('#btn-hand'); await page.click('[data-tool="pen"]'); m = await mode();
  ok(m.mode === 'draw' && m.hand === 'false' && m.pen === 'true', 'Werkzeug antippen schaltet die Hand aus', JSON.stringify(m));
  await page.keyboard.down('Space'); m = await mode();
  ok(m.mode === 'move', 'Leertaste halten → bewegen', JSON.stringify(m));
  await page.keyboard.up('Space'); m = await mode();
  ok(m.mode === 'draw' && m.pen === 'true', 'Leertaste los → zurück zum Stift', JSON.stringify(m));

  // ── Farbe ──────────────────────────────────────────────────────────────
  await page.click('#btn-color');
  ok(await visible('#pop-color') && !(await visible('#pop-size')), 'Farb-Popover offen, Stärke-Popover zu');
  ok(await attr('#btn-color', 'aria-expanded') === 'true', 'Farb-Knopf aria-expanded');
  await shot('popover-farbe.png');
  await page.click('.swatch[data-color="#e03131"]');
  ok(await $(() => getComputedStyle(document.getElementById('chip-color')).backgroundColor) === 'rgb(224, 49, 49)', 'Farbe geändert: Knopf zeigt Rot', await attr('#btn-color', 'aria-label'));
  await page.click('#btn-color-picker');
  ok(await visible('#color-picker-popup') && await $(() => !!document.querySelector('#iro-container .IroColorPicker')), 'freie Farbwahl (iro.js) im Farb-Popover erreichbar');
  await page.click('#btn-color-picker');
  ok(!(await visible('#color-picker-popup')), 'freie Farbwahl wieder zu');

  // ── Stärke ─────────────────────────────────────────────────────────────
  await page.click('#btn-size');
  ok(await visible('#pop-size') && !(await visible('#pop-color')), 'Stärke-Popover offen, Farb-Popover zu');
  await shot('popover-staerke.png');
  await page.click('.size[data-size="4"]');
  ok(await $(() => document.getElementById('chip-size').style.width) === '20px' && /Sehr dick/.test(await attr('#btn-size', 'aria-label')), 'Stärke geändert: Knopf zeigt „Sehr dick“', await attr('#btn-size', 'aria-label'));
  await page.keyboard.press('Escape');
  ok(!(await visible('#pop-size')), 'Escape schließt Popover');
  await drag(300, 400, 600, 400); await sleep(600);
  const px = await pixel(450, 400);
  ok(px[0] === 224 && px[1] === 49 && px[2] === 49 && px[3] === 255, 'neuer Strich ist rot und dick', px.join(','));
  const px2 = await pixel(450, 406);
  ok(px2[3] === 255, 'Strichstärke wirkt (6 px neben der Mitte noch Tinte)', px2.join(','));
  await page.click('#btn-color'); await page.click('.swatch[data-color="#14171c"]');
  await page.click('#btn-size'); await page.click('.size[data-size="2"]');
  await drag(200, 200, 201, 201); // Tipp auf die Fläche schließt das Popover
  ok(!(await visible('#pop-size')) && !(await visible('#pop-color')), 'Tipp auf die Zeichenfläche schließt Popover');

  // ── Seiten-Menü ────────────────────────────────────────────────────────
  await page.click('#btn-page-menu');
  ok(await visible('#pop-page'), 'Seiten-Menü offen');
  ok(await $(() => ['btn-share', 'btn-menu-export-png', 'btn-menu-export-svg', 'btn-zen', 'btn-clear', 'btn-delete-page'].every(id => document.getElementById(id)?.closest('#pop-page')) && document.querySelectorAll('#pop-page .bg-btn').length === 3), 'Seiten-Menü: Papier, Teilen, Export, Vollbild, Leeren, Löschen');
  await shot('menue-seite.png');
  await page.click('.bg-btn[data-bg="lined"]'); await sleep(300);
  ok(await attr('.bg-btn[data-bg="lined"]', 'aria-pressed') === 'true', 'Papierart umgestellt (liniert)');
  await page.click('.bg-btn[data-bg="grid"]'); await sleep(300);
  await page.click('#btn-share'); await sleep(1200);
  ok(await $(() => !document.getElementById('share-modal').classList.contains('hidden')) && (await $(() => document.getElementById('share-link').value)).includes('#nb-'), '#btn-share öffnet den Teilen-Dialog mit Link');
  ok(!(await visible('#pop-page')), 'Menü nach Auswahl geschlossen');
  await page.click('#btn-close-share');

  // ── Notizbuch-Titel öffnet die Liste ───────────────────────────────────
  await page.click('#btn-notebooks'); await sleep(400);
  ok(await $(() => document.querySelector('.sidebar').classList.contains('sidebar-open')) && await visible('#notebook-list > *'), 'Titel öffnet die Notizbuch-Liste');
  await page.keyboard.press('Escape'); await sleep(400);
  ok(await $(() => !document.querySelector('.sidebar').classList.contains('sidebar-open')), 'Escape schließt die Liste');

  // ── Seiten-Pille ───────────────────────────────────────────────────────
  const pg = () => $(() => ({ t: document.getElementById('page-indicator').textContent, prev: document.getElementById('btn-prev').disabled, next: document.getElementById('btn-next').disabled }));
  let p = await pg();
  ok(p.t === '1 / 1' && p.prev && p.next, 'Start: 1 / 1, ‹ und › gesperrt', JSON.stringify(p));
  await page.click('#btn-add-page'); await sleep(600); p = await pg();
  ok(p.t === '2 / 2' && p.next && !p.prev, '„+“ legt Seite an: 2 / 2', JSON.stringify(p));
  await $(() => document.getElementById('btn-next').click()); await sleep(400);
  await $(() => { const b = document.getElementById('btn-next'); b.disabled = false; b.click(); }); await sleep(600); p = await pg();
  ok(p.t === '2 / 2', '„›“ auf der letzten Seite legt keine Seite an', JSON.stringify(p));
  ok(await ink() === 0, 'neue Seite ist leer');
  await page.click('#btn-page-overview'); await sleep(200);
  ok((await pg()).t === '2 / 2' && await $(() => document.getElementById('btn-page-overview').tagName === 'BUTTON' && !document.getElementById('pages-modal').classList.contains('hidden')), '#btn-page-overview ist ein Button und öffnet die Seitenübersicht (Einzelheiten: ui-d.cjs)');
  await page.keyboard.press('Escape'); await sleep(200);
  ok(await $(() => document.getElementById('pages-modal').classList.contains('hidden')) && (await pg()).t === '2 / 2', 'Esc schließt die Seitenübersicht, Zähler unverändert');
  await page.click('#btn-prev'); await sleep(600); p = await pg();
  ok(p.t === '1 / 2' && !p.next && p.prev, '‹ zurück auf 1 / 2', JSON.stringify(p));
  ok(await ink() > 0, 'Seite 1 zeigt die Striche wieder');
  await page.click('#btn-next'); await sleep(600); ok((await pg()).t === '2 / 2', '› vor auf 2 / 2');
  await page.click('#btn-prev'); await sleep(900);

  // ── Hinweis „Weiterer Inhalt“ ──────────────────────────────────────────
  const hint = () => $(() => ({ shown: !document.getElementById('btn-edge-hint').hidden, dir: document.getElementById('btn-edge-hint').dataset.dir, off: document.getElementById('main').dataset.off, text: document.getElementById('btn-edge-hint').textContent.trim() }));
  let h = await hint();
  ok(!h.shown && h.off === 'false', 'Alles sichtbar: kein Hinweis', JSON.stringify(h));
  for (let i = 0; i < 8; i++) await page.click('#btn-zoom-in');
  await sleep(300); h = await hint();
  ok(h.shown && h.off === 'true' && h.text === 'Weiterer Inhalt', 'stark hineingezoomt: Hinweis „Weiterer Inhalt“ + „Alles“ markiert', JSON.stringify(h));
  ok(await $(() => getComputedStyle(document.getElementById('btn-fit'), '::after').content !== 'none'), '„Alles“ trägt den Punkt');
  await shot('hinweis-inhalt.png');
  await page.click('#btn-hand');
  const dirs = {};
  for (const [name, dx, dy] of [['left', -1, 0], ['right', 1, 0], ['up', 0, -1], ['down', 0, 1]]) {
    // Ansicht so weit schieben, dass der Inhalt in Richtung `name` aus dem Bild liegt
    for (let i = 0; i < 6; i++) await drag(700 - dx * 300, 400 - dy * 250, 700 + dx * 300, 400 + dy * 250);
    await sleep(200); h = await hint(); dirs[name] = h.dir;
    const b = await cbox();
    const pos = await $(() => { const r = document.getElementById('btn-edge-hint').getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; });
    const atEdge = name === 'left' ? pos.cx < b.x + b.w * 0.25 : name === 'right' ? pos.cx > b.x + b.w * 0.75 : name === 'up' ? pos.cy < b.y + b.h * 0.25 : pos.cy > b.y + b.h * 0.6;
    ok(h.shown && h.dir === name && atEdge, `Inhalt liegt ${name}: Hinweis am passenden Rand`, JSON.stringify({ ...h, ...pos }));
    if (name === 'left') await shot('hinweis-inhalt-links.png');
    for (let i = 0; i < 6; i++) await drag(700 + dx * 300, 400 + dy * 250, 700 - dx * 300, 400 - dy * 250);
  }
  for (let i = 0; i < 6; i++) await drag(1000, 400, 400, 400);
  await page.click('#btn-hand'); await sleep(200);
  ok(await ink() === 0, 'Ansicht verschoben: kein Strich mehr im Bild');
  await page.click('#btn-fit'); await sleep(300); h = await hint();
  ok(!h.shown && h.off === 'false' && await ink() > 0, '„Alles“ holt die Striche zurück, Hinweis weg', JSON.stringify(h));
  for (let i = 0; i < 8; i++) await page.click('#btn-zoom-in');
  await sleep(200); await page.click('#btn-edge-hint'); await sleep(300); h = await hint();
  ok(!h.shown && await ink() > 0, 'Tipp auf den Hinweis = alles zeigen', JSON.stringify(h));
  // Neuer Strich außerhalb des bisherigen Bereichs → Grenzen werden (entprellt) neu bestimmt
  for (let i = 0; i < 3; i++) await page.click('#btn-zoom-out');
  await sleep(200); await drag(40, 40, 120, 40); await sleep(1000);
  for (let i = 0; i < 3; i++) await page.click('#btn-zoom-in');
  await sleep(300); h = await hint();
  ok(h.shown, 'neuer Strich am Rand zählt nach dem Hineinzoomen zum „weiteren Inhalt“', JSON.stringify(h));
  await page.click('button[title="Rückgängig"]'); await sleep(1000); h = await hint();
  ok(!h.shown, 'nach Undo des Rand-Strichs: Hinweis weg (Grenzen neu bestimmt)', JSON.stringify(h));
  await page.click('#btn-fit'); await sleep(300);

  // ── Theme ──────────────────────────────────────────────────────────────
  const look = () => $(() => ({ theme: document.documentElement.dataset.theme, choice: window.getTheme(), paper: getComputedStyle(document.getElementById('canvas-container')).backgroundColor, bar: getComputedStyle(document.querySelector('.tb')).backgroundColor, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), faint: getComputedStyle(document.documentElement).getPropertyValue('--text-faint').trim() }));
  ok(typeof (await $(() => typeof window.setTheme)) === 'string' && await $(() => typeof window.setTheme === 'function'), 'setTheme() vorhanden');
  await $(() => window.setTheme('dark')); await sleep(300);
  let l = await look();
  ok(l.theme === 'dark' && l.paper === 'rgb(255, 255, 255)' && l.bar === 'rgb(27, 30, 36)' && l.accent === '#74b8ff' && l.faint === '', 'dunkel: Leiste dunkel, Papier weiß, Akzent #74b8ff, kein --text-faint', JSON.stringify(l));
  await shot('main-dark-1400.png');
  await noHScroll('1400×900 dunkel');
  await page.reload();
  const afterReload = await $(() => document.documentElement.dataset.theme);
  ok(afterReload === 'dark', 'gespeicherte Wahl gilt sofort nach Reload (kein Aufblitzen)', afterReload);
  await ready(); await sleep(1500);
  ok(await $(() => new Promise(res => { const r = indexedDB.open('notizbuch-settings', 1); r.onsuccess = () => { r.result.transaction('settings').objectStore('settings').get('device:theme').onsuccess = e => res(e.target.result); }; })) === 'dark', 'Wahl liegt in IndexedDB (notizbuch-settings)');
  // Gespeicherte Wahl hat Vorrang vor der localStorage-Kopie
  await $(() => localStorage.removeItem('notizbuch:theme')); await page.reload(); await ready(); await sleep(800);
  ok((await look()).theme === 'dark', 'IndexedDB-Wahl hat Vorrang (auch ohne localStorage-Kopie)');
  await $(() => window.setTheme('light')); await sleep(300); l = await look();
  ok(l.theme === 'light' && l.paper === 'rgb(255, 255, 255)' && l.bar === 'rgb(255, 255, 255)' && l.accent === '#0b7285', 'hell: Papier weiß, Akzent #0b7285', JSON.stringify(l));
  await page.emulateMedia({ colorScheme: 'dark' }); await sleep(200);
  ok((await look()).theme === 'light', 'gespeicherte Wahl „hell“ hat Vorrang vor dem System');
  await $(() => window.setTheme('system')); await sleep(200);
  ok((await look()).theme === 'dark', '„system“ folgt dem System (dunkel)');
  await page.emulateMedia({ colorScheme: 'light' }); await sleep(200);
  ok((await look()).theme === 'light', '„system“ reagiert live auf Änderung (hell)');

  // ── Breiten ────────────────────────────────────────────────────────────
  const layout = () => $(() => { const r = s => document.querySelector(s).getBoundingClientRect(); const c = r('#canvas-container'); return { lbl: getComputedStyle(document.querySelector('.tool .lbl')).display !== 'none', toolsBelow: r('.toolrow').top >= c.bottom - 1, zstep: getComputedStyle(document.getElementById('btn-zoom-in')).display !== 'none', fit: getComputedStyle(document.getElementById('btn-fit')).display !== 'none', minTap: Math.min(...[...document.querySelectorAll('.main .tb button, .main .float button, .main button.float')].filter(e => !e.hidden && e.getClientRects().length).map(e => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height))), minW: Math.min(...[...document.querySelectorAll('.main .tb button, .main .float button, .main button.float')].filter(e => !e.hidden && e.getClientRects().length).map(e => e.getBoundingClientRect().width)), minH: Math.min(...[...document.querySelectorAll('.main .tb button, .main .float button, .main button.float')].filter(e => !e.hidden && e.getClientRects().length).map(e => e.getBoundingClientRect().height)), rowButtons: document.querySelectorAll('.toolrow button.tool, .toolrow button.opt, .toolrow button.mode').length }; });
  await sleep(300); let ly = await layout();
  ok(ly.lbl && !ly.toolsBelow && ly.zstep, '1400: Werkzeuge mit Beschriftung, oben', JSON.stringify(ly));
  await noHScroll('1400×900 hell'); await shot('main-light-1400.png');

  await page.setViewportSize({ width: 1200, height: 800 }); await sleep(500);
  const free = await $(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); const bad = []; for (let x = 150; x <= 450; x += 25) for (let y = 180; y <= 500; y += 20) { const e = document.elementFromPoint(c.x + x, c.y + y); if (!e || e.tagName !== 'CANVAS') bad.push(`${x},${y}:${e?.id || e?.className}`); } return bad; });
  ok(free.length === 0, '1200×800: Bereich x 150..450 / y 180..500 der Zeichenfläche ist frei', free.slice(0, 5).join(' '));

  await page.setViewportSize({ width: 1024, height: 768 }); await sleep(500); await page.click('#btn-fit'); await sleep(300); ly = await layout();
  ok(!ly.lbl && !ly.toolsBelow && ly.zstep && ly.minTap >= 44, '1024: nur Symbole, oben, Bedienflächen ≥ 44 px', JSON.stringify(ly));
  await noHScroll('1024×768'); await shot('main-light-1024.png');

  await page.setViewportSize({ width: 360, height: 740 }); await sleep(500); await page.click('#btn-fit'); await sleep(300); ly = await layout();
  ok(!ly.lbl && ly.toolsBelow && !ly.zstep && ly.fit && ly.rowButtons === 8 && ly.minW >= 40 && ly.minH >= 44, '360: Werkzeuge unten (8 Knöpfe), Zoom-Pille nur „Alles“, Bedienflächen mindestens 40×44 px', JSON.stringify(ly));
  await noHScroll('360×740 hell'); await shot('main-light-360.png');
  await page.click('#btn-color'); await sleep(200);
  ok(await $(() => { const r = document.getElementById('pop-color').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= document.querySelector('.toolrow').getBoundingClientRect().top; }), '360: Farb-Popover liegt vollständig im Bild über der Werkzeugreihe');
  await shot('popover-farbe-360.png'); await page.keyboard.press('Escape');
  await page.click('#btn-page-menu'); await sleep(200);
  ok(await $(() => { const r = document.getElementById('pop-page').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), '360: Seiten-Menü liegt vollständig im Bild');
  await shot('menue-seite-360.png'); await page.keyboard.press('Escape');
  await $(() => window.setTheme('dark')); await sleep(300);
  await noHScroll('360×740 dunkel'); await shot('main-dark-360.png');
  ok((await look()).paper === 'rgb(255, 255, 255)', '360 dunkel: Papier bleibt weiß');
  await $(() => window.setTheme('system')); await sleep(200);

  // ── Sync-Status öffnet die Einstellungen bei „Verbindung“ (Teil B; Details in ui-b.cjs) ──
  await page.setViewportSize({ width: 1400, height: 900 }); await sleep(400);
  ok(/\S/.test(await $(() => document.getElementById('sync-text').textContent)), 'Sync-Status zeigt Text', await $(() => document.getElementById('sync-text').textContent));
  await page.click('#sync-status'); await sleep(200);
  ok(await visible('#settings-modal') && await visible('#set-panel-connection') && await $(() => document.getElementById('console').classList.contains('debug-off')), 'Klick auf den Sync-Status öffnet Einstellungen → Verbindung (Diagnose bleibt aus)');
  await page.click('#set-diag'); await sleep(200);
  ok(await $(() => !document.getElementById('console').classList.contains('debug-off')) && /fill-v48/.test(await $(() => document.getElementById('console').innerText)), 'Schalter „Sync-Diagnose“ blendet das Overlay ein (Version v45)');
  await page.click('#set-diag'); await sleep(200);
  ok(await $(() => document.getElementById('console').classList.contains('debug-off')), 'Schalter aus blendet es wieder aus');
  await page.keyboard.press('Escape'); await sleep(200);
  ok(!(await visible('#settings-modal')), 'Escape schließt die Einstellungen');

  // ── Konsole ────────────────────────────────────────────────────────────
  const bad = logs.filter(l => /PAGEERROR|^error|ReferenceError|TypeError|fehlgeschlagen/.test(l) && !/User-Initiated Abort|WebRTC blockiert/.test(l));
  ok(bad.length === 0, 'keine Konsolenfehler', bad.slice(0, 8).join(' | '));
  if (process.env.LOGS) console.log(logs.slice(-40).join('\n'));
  await browser.close();
  console.log(`Screenshots: ${OUT}`);
  console.log(fails ? `ERGEBNIS: ${fails} FEHLER` : 'ERGEBNIS: ALLES OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TESTFEHLER', e); process.exit(2); });
