// UI-Test Redesign Teil D: node ui-d.cjs <URL>
// Seitenübersicht (Vorschaubilder, träge geladen), gelöschte Seiten nur noch in der Übersicht,
// Wiederherstellen über zwei Geräte (restoredAt), letzte Seite löschen, 40 Seiten, 360 px.
// Zwei Kontexte mit Geräte-Sync wie accept.cjs device. Schreibt Screenshots nach /tmp/notes-ui/.
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
  const dialogs = [];
  const mk = async name => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true, colorScheme: 'light' });
    await ctx.addInitScript(() => localStorage.setItem('notizbuch:debugOverlay', '1'));
    if (process.env.NO_P2P) await ctx.addInitScript(() => { RTCPeerConnection.prototype.setRemoteDescription = () => Promise.reject(new Error('WebRTC blockiert (Test)')); });
    const page = await ctx.newPage(); const logs = [];
    page.on('console', m => { const t = m.text(); if (!/WebSocket connection|willReadFrequently|Password field/.test(t)) logs.push(`${m.type()}: ${t.slice(0, 220)}`); });
    page.on('pageerror', e => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
    page.on('dialog', d => { dialogs.push(`${name} ${d.type()}: ${d.message().slice(0, 80)}`); d.dismiss().catch(() => {}); });
    return { ctx, page, logs };
  };
  const ready = p => p.waitForFunction(() => /device: [0-9a-f]/.test(document.getElementById('console')?.innerText || ''), null, { timeout: 20000 });
  const A = await mk('A'), B = await mk('B');
  const a = A.page, b = B.page;
  await a.goto(URL); await a.click('#btn-new-start'); await a.click('#btn-key-confirmed'); await ready(a); await sleep(3000);
  const keyHex = await a.evaluate(() => JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw')).map(x => x.toString(16).padStart(2, '0')).join(''));
  await b.goto(URL + '#' + keyHex); await ready(b).catch(() => {});
  await sleep(8000);

  const cnt = p => p.evaluate(() => { const m = (document.getElementById('console')?.innerText || '').match(/striche: (\d+)/); return m ? Number(m[1]) : -1; });
  const line = async (p, x0, y0, x1, y1) => { const box = await p.evaluate(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); return { x: c.x, y: c.y }; });
    await p.mouse.move(box.x + x0, box.y + y0); await p.mouse.down(); for (let i = 1; i <= 16; i++) await p.mouse.move(box.x + x0 + (x1 - x0) * i / 16, box.y + y0 + (y1 - y0) * i / 16); await p.mouse.up(); };
  const menu = async (p, id) => { await p.click('#btn-page-menu'); await p.click('#' + id); };
  const toast = p => p.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map(t => ({ text: t.querySelector('span').textContent, action: t.querySelector('button')?.textContent || '' })));
  const ind = p => p.evaluate(() => document.getElementById('page-indicator').textContent.trim());
  const reload = async p => { await p.reload(); await ready(p).catch(() => {}); };
  const shot = (p, name) => p.screenshot({ path: `${OUT}/${name}` });
  const isOpen = p => p.evaluate(() => !document.getElementById('pages-modal').classList.contains('hidden'));
  const openOv = async p => { await p.click('#btn-page-overview'); await sleep(150); };
  // Warten, bis alle sichtbaren Kacheln ihr Vorschaubild haben
  const thumbsDone = (p, ms = 10000) => p.waitForFunction(() => { const t = [...document.querySelectorAll('#pages-sheet .thumb[data-page]')].filter(x => x._visible); return t.length > 0 && t.every(x => x._sig); }, null, { timeout: ms }).then(() => true, () => false);
  const tiles = p => p.evaluate(() => ({
    grid: [...document.querySelectorAll('#pages-grid .thumb[data-page]')].map(t => ({ cap: t.querySelector('.cap span').textContent, current: t.classList.contains('current'), aria: t.querySelector('.thumb-pic').getAttribute('aria-current') || '', label: t.querySelector('.thumb-pic').getAttribute('aria-label') })),
    neu: document.querySelectorAll('#pages-grid .thumb .new').length,
    trash: [...document.querySelectorAll('#pages-trash .thumb[data-page]')].map(t => ({ cap: t.querySelector('.cap span').textContent, btn: t.querySelector('.cap button')?.textContent || '' })),
    trashShown: !document.getElementById('pages-trash-section').hidden,
    count: document.getElementById('pages-count').textContent
  }));
  // Pixel der Vorschau: „dunkel“ = Strichfarbe, „getönt“ = alles Nicht-Weiße (auch Papierlinien)
  const pix = p => p.evaluate(() => [...document.querySelectorAll('#pages-sheet .thumb[data-page] canvas')].map(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let dark = 0, tinted = 0, clear = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 255) clear++; const s = d[i] + d[i + 1] + d[i + 2]; if (s < 750) tinted++; if (s < 380) dark++; } return { dark, tinted, clear, url: c.toDataURL().length + ':' + c.toDataURL().slice(-60) }; }));
  const mainState = p => p.evaluate(() => { const c = document.getElementById('static-canvas'); const u = c.toDataURL(); let h = 0; for (let i = 0; i < u.length; i += 7) h = (h * 31 + u.charCodeAt(i)) | 0; return `${c.width}x${c.height}:${u.length}:${h}:${document.getElementById('page-indicator').textContent.trim()}`; });

  // ── 4 Seiten, Seite 1 und 3 unterschiedlich bezeichnet ─────────────────
  for (let i = 0; i < 3; i++) { await a.click('#btn-add-page'); await sleep(500); }
  let t = await toast(a);
  ok(t.some(x => /Seite 4 angelegt/.test(x.text)) && await ind(a) === '4 / 4', 'Neue Seite: Hinweis „Seite 4 angelegt“, Zähler 4 / 4', `${JSON.stringify(t)} ${await ind(a)}`);
  for (let i = 0; i < 3; i++) { await a.click('#btn-prev'); await sleep(400); }
  await line(a, 200, 250, 600, 250); await line(a, 200, 330, 600, 330); await sleep(400);
  await a.click('#btn-next'); await sleep(400); await a.click('#btn-next'); await sleep(400);
  await line(a, 250, 200, 650, 500); await sleep(1500);
  await a.click('#btn-prev'); await sleep(400); await a.click('#btn-prev'); await sleep(2500);
  ok(await ind(a) === '1 / 4' && await cnt(a) === 2 && /\/ 4$/.test(await ind(b)), 'A steht auf Seite 1 (2 Striche), B kennt 4 Seiten', `A=${await ind(a)} striche=${await cnt(a)} B=${await ind(b)}`);

  // ── Übersicht öffnen ───────────────────────────────────────────────────
  const before = await mainState(a);
  await openOv(a);
  ok(await isOpen(a) && await a.evaluate(() => { const d = document.getElementById('pages-sheet'); return d.getAttribute('role') === 'dialog' && d.getAttribute('aria-modal') === 'true' && !!document.getElementById(d.getAttribute('aria-labelledby')).textContent && d.contains(document.activeElement); }), 'Zähler in der Seiten-Pille öffnet die Übersicht (Dialog mit Titel, Fokus liegt darin)');
  ok(await thumbsDone(a), 'Vorschaubilder der sichtbaren Kacheln sind fertig');
  let tl = await tiles(a);
  ok(tl.grid.length === 4 && tl.neu === 1 && !tl.trashShown && /4 Seiten/.test(tl.count), '4 Kacheln + „Neue Seite“, kein Abschnitt „Gelöschte Seiten“', JSON.stringify({ n: tl.grid.length, neu: tl.neu, trash: tl.trashShown, count: tl.count }));
  ok(tl.grid[0].current && tl.grid[0].aria === 'page' && /aktuell/.test(tl.grid[0].cap) && tl.grid.filter(x => x.current).length === 1 && tl.grid[2].cap === 'Seite 3', 'aktuelle Seite (1) ist markiert, Kacheln tragen die Seitennummer', JSON.stringify(tl.grid.map(x => x.cap)));
  let px = await pix(a);
  ok(px[0].dark > 20 && px[2].dark > 20 && px[0].url !== px[2].url, 'Vorschau von Seite 1 und 3 enthält Striche (dunkle Pixel) und sie unterscheiden sich', `dunkel: ${px.map(x => x.dark).join(' / ')}`);
  ok(px[1].dark === 0 && px[3].dark === 0 && px[1].tinted > 0 && px.every(x => x.clear === 0), 'Vorschau von Seite 2 und 4: keine Striche, nur Papierlinien auf weißem (deckendem) Papier', `dunkel: ${px.map(x => x.dark).join(' / ')} getönt: ${px.map(x => x.tinted).join(' / ')} transparent: ${px.map(x => x.clear).join(' / ')}`);
  ok(await a.evaluate(() => { const c = [...document.querySelectorAll('canvas')]; return c[0].id === 'bg-canvas' && c[1].id === 'static-canvas' && c[2].id === 'active-canvas' && c.length >= 7; }), 'die drei Zeichenflächen bleiben die ersten Canvases im Dokument (canvas[2] = aktive Fläche)');
  await sleep(300); await shot(a, 'seiten-light-1400.png');

  // Esc / Schließen-Knopf / Fokus
  await a.keyboard.press('Tab'); await a.keyboard.press('Tab');
  ok(await a.evaluate(() => document.getElementById('pages-sheet').contains(document.activeElement)), 'Tab bleibt in der Übersicht');
  await a.keyboard.press('Escape'); await sleep(200);
  ok(!(await isOpen(a)) && await a.evaluate(() => document.activeElement?.id === 'btn-page-overview'), 'Esc schließt, Fokus zurück auf dem Zähler');
  ok(await mainState(a) === before && await cnt(a) === 2, 'Hauptansicht nach der Übersicht unverändert (Bild der Zeichenfläche, Zähler, Strichzahl)', `${before} → ${await mainState(a)}`);
  await openOv(a); await a.click('#btn-close-pages'); await sleep(200);
  ok(!(await isOpen(a)), 'Schließen-Knopf schließt');

  // Tipp auf Kachel 3
  await openOv(a);
  ok(await a.evaluate(() => [...document.querySelectorAll('#pages-grid .thumb[data-page]')].every(x => x._sig)), 'zweites Öffnen: Vorschauen kommen sofort aus dem Cache');
  await a.click('#pages-grid .thumb:nth-child(3) .thumb-pic'); await sleep(900);
  ok(!(await isOpen(a)) && await ind(a) === '3 / 4' && await cnt(a) === 1, 'Tipp auf Kachel 3 wechselt zur Seite 3 und schließt', `${await ind(a)} striche=${await cnt(a)}`);
  await line(a, 250, 520, 650, 220); await sleep(600);
  ok(await cnt(a) === 2, 'Zeichnen geht danach weiter (Seite 3: 2 Striche)', `striche=${await cnt(a)}`);
  await sleep(1500); await openOv(a); await thumbsDone(a);
  const px2 = await pix(a);
  ok(px2[2].url !== px[2].url && px2[0].url === px[0].url && (await tiles(a)).grid[2].current, 'nur die geänderte Seite 3 bekommt eine neue Vorschau; jetzt ist Seite 3 markiert');
  await a.keyboard.press('Escape'); await sleep(200);

  // ── Seite 2 löschen, festschreiben lassen ──────────────────────────────
  if (!/^2/.test(await ind(b))) { await b.evaluate(() => document.getElementById('btn-page-overview').click()); await sleep(300); await b.click('#pages-grid .thumb:nth-child(2) .thumb-pic'); await sleep(800); }
  ok(await ind(b) === '2 / 4', 'B steht (über die Übersicht) auf Seite 2', await ind(b));
  await a.click('#btn-prev'); await sleep(600);
  await menu(a, 'btn-delete-page'); await sleep(600);
  t = await toast(a);
  ok(t.some(x => /Seite 2 gelöscht/.test(x.text) && x.action === 'Rückgängig') && await ind(a) === '2 / 3' && await cnt(a) === 2, 'Löschen: Hinweis mit „Rückgängig“, Ansicht springt auf die Nachbarseite (frühere Seite 3), Zähler 2 / 3', `${JSON.stringify(t)} ${await ind(a)} striche=${await cnt(a)}`);
  await sleep(11000);
  ok(await ind(a) === '2 / 3' && await ind(b) === '2 / 3' && await cnt(b) === 2, 'festgeschrieben: Zähler „… / 3“ bei A und B, B ist von der gelöschten Seite auf die Nachbarseite gesprungen', `A=${await ind(a)} B=${await ind(b)} B-striche=${await cnt(b)}`);
  ok(!/gelöscht/.test(await ind(a) + await ind(b)) && !/gelöscht/.test(await a.evaluate(() => document.getElementById('notebook-title').textContent)), 'in Zähler und Titel steht nichts mehr von „gelöscht“');
  await openOv(a); await thumbsDone(a); await openOv(b); await thumbsDone(b);
  const [ta, tb] = [await tiles(a), await tiles(b)];
  ok(ta.grid.length === 3 && ta.trashShown && ta.trash.length === 1 && ta.trash[0].btn === 'Wiederherstellen' && tb.grid.length === 3 && tb.trash.length === 1, 'Übersicht bei A und B: 3 Seiten, die gelöschte steht unter „Gelöschte Seiten“ mit „Wiederherstellen“', JSON.stringify({ a: ta.trash, b: tb.trash }));
  ok(!/30 Tage/.test(await a.evaluate(() => document.getElementById('pages-sheet').textContent)), 'kein Text zu einer Aufbewahrungsfrist');
  await a.evaluate(() => document.getElementById('pages-trash-section').scrollIntoView()); await sleep(300); await shot(a, 'seiten-geloescht.png');

  // ── Wiederherstellen ───────────────────────────────────────────────────
  await a.click('#pages-trash [data-restore]'); await sleep(800);
  tl = await tiles(a);
  ok(tl.grid.length === 4 && !tl.trashShown && (await toast(a)).some(x => /wiederhergestellt/.test(x.text)) && await a.evaluate(() => document.getElementById('pages-sheet').contains(document.activeElement)), 'Wiederherstellen: A zeigt wieder 4 Kacheln, Hinweis, Fokus bleibt in der Übersicht', JSON.stringify({ n: tl.grid.length, trash: tl.trashShown }));
  await a.keyboard.press('Escape'); await sleep(4000);
  const tb2 = await tiles(b);
  ok(/\/ 4$/.test(await ind(a)) && /\/ 4$/.test(await ind(b)) && tb2.grid.length === 4 && !tb2.trashShown, 'wiederhergestellt: Zähler „… / 4“ bei A und B, offene Übersicht von B zieht nach', `A=${await ind(a)} B=${await ind(b)} B-Kacheln=${tb2.grid.length}`);
  await b.keyboard.press('Escape');
  await sleep(9000);
  ok(/\/ 4$/.test(await ind(a)) && /\/ 4$/.test(await ind(b)), '… hält nach 9 s (Relay-Zyklen)', `A=${await ind(a)} B=${await ind(b)}`);
  await reload(b); await reload(a); await sleep(8000);
  ok(/\/ 4$/.test(await ind(a)) && /\/ 4$/.test(await ind(b)), '… auch nach Reload beider', `A=${await ind(a)} B=${await ind(b)}`);
  ok(await a.evaluate(async () => { const m = localStorage.getItem('notizbuch:pendingPageOp'); return m === null; }), 'kein liegengebliebener Merkzettel');

  // Erneut löschen und wiederherstellen (deletedAt muss über restoredAt kommen und umgekehrt)
  await openOv(a); await a.click('#pages-grid .thumb:nth-child(2) .thumb-pic'); await sleep(800);
  await menu(a, 'btn-delete-page'); await sleep(11000);
  ok(/\/ 3$/.test(await ind(a)) && /\/ 3$/.test(await ind(b)), 'wiederhergestellte Seite erneut löschen: „… / 3“ bei A und B', `A=${await ind(a)} B=${await ind(b)}`);
  await openOv(b); await b.click('#pages-trash [data-restore]'); await sleep(500); await b.keyboard.press('Escape'); await sleep(4500);
  ok(/\/ 4$/.test(await ind(a)) && /\/ 4$/.test(await ind(b)), 'diesmal stellt B wieder her: „… / 4“ bei A und B', `A=${await ind(a)} B=${await ind(b)}`);

  // „Rückgängig“ im Hinweis führt zur Seite zurück
  await openOv(a); await a.click('#pages-grid .thumb:nth-child(3) .thumb-pic'); await sleep(800);
  ok(await ind(a) === '3 / 4' && await cnt(a) === 2, 'A auf Seite 3 (2 Striche)', `${await ind(a)} striche=${await cnt(a)}`);
  await menu(a, 'btn-delete-page'); await sleep(500);
  ok(await ind(a) === '3 / 3' && await cnt(a) === 0, 'Seite 3 gelöscht: Ansicht zeigt die frühere Seite 4', `${await ind(a)} striche=${await cnt(a)}`);
  await a.click('#toasts .toast button'); await sleep(800);
  ok(await ind(a) === '3 / 4' && await cnt(a) === 2, '„Rückgängig“ führt zur wiederhergestellten Seite 3 zurück', `${await ind(a)} striche=${await cnt(a)}`);
  await sleep(3500);
  ok(/\/ 4$/.test(await ind(b)), 'B hat davon nichts mitbekommen (4 Seiten)', await ind(b));

  // ── Dunkel ─────────────────────────────────────────────────────────────
  await a.click('#btn-notebooks'); await sleep(300); await a.click('#btn-settings'); await sleep(300); await a.click('#set-tab-general'); await a.click('#theme-seg [data-choice="dark"]'); await sleep(300); await a.keyboard.press('Escape'); await sleep(300);
  if (await a.evaluate(() => !!document.querySelector('.sidebar.sidebar-open'))) { await a.keyboard.press('Escape'); await sleep(300); }
  await openOv(a); await thumbsDone(a); await sleep(300); await shot(a, 'seiten-dark-1400.png');
  ok(await a.evaluate(() => { const p = document.querySelector('#pages-grid .thumb-pic canvas'); const d = p.getContext('2d').getImageData(2, 2, 1, 1).data; return document.documentElement.dataset.theme === 'dark' && d[0] > 215 && d[1] > 215 && d[2] > 215 && getComputedStyle(document.getElementById('pages-sheet')).backgroundColor === 'rgb(27, 30, 36)'; }), 'dunkel: Übersicht nutzt die Tokens, das Papier der Vorschauen bleibt weiß');
  await a.keyboard.press('Escape'); await sleep(200);
  await a.click('#btn-notebooks'); await sleep(300); await a.click('#btn-settings'); await sleep(300); await a.click('#theme-seg [data-choice="light"]'); await sleep(300); await a.keyboard.press('Escape'); await sleep(300);

  // ── Neues Notizbuch: letzte verbliebene Seite löschen ──────────────────
  if (!(await a.evaluate(() => !!document.querySelector('.sidebar.sidebar-open')))) { await a.click('#btn-notebooks'); await sleep(300); }
  await a.click('#btn-add-notebook'); await sleep(1500);
  if (await a.evaluate(() => !!document.querySelector('.sidebar.sidebar-open'))) { await a.keyboard.press('Escape'); await sleep(300); }
  await line(a, 200, 250, 600, 250); await sleep(1500);
  ok(await ind(a) === '1 / 1' && await cnt(a) === 1, 'neues Notizbuch: 1 Seite, 1 Strich', `${await ind(a)} striche=${await cnt(a)}`);
  ok(await a.evaluate(() => { document.getElementById('btn-page-menu').click(); const d = document.getElementById('btn-delete-page').disabled; document.getElementById('btn-page-menu').click(); return !d; }), '„Seite löschen“ ist auch bei der letzten Seite möglich');
  await menu(a, 'btn-delete-page'); await sleep(600);
  ok(await ind(a) === '1 / 1' && await cnt(a) === 0, 'letzte Seite gelöscht: sofort eine neue leere Seite (1 / 1, 0 Striche)', `${await ind(a)} striche=${await cnt(a)}`);
  await a.click('#toasts .toast button'); await sleep(800);
  await openOv(a); tl = await tiles(a); await a.keyboard.press('Escape');
  ok(await ind(a) === '1 / 1' && await cnt(a) === 1 && tl.grid.length === 1 && !tl.trashShown, '„Rückgängig“: alte Seite zurück, die Ersatzseite ist wieder weg', `${await ind(a)} striche=${await cnt(a)} Kacheln=${tl.grid.length}`);
  await menu(a, 'btn-delete-page'); await sleep(11000);
  await openOv(a); await thumbsDone(a); tl = await tiles(a); px = await pix(a); await a.keyboard.press('Escape');
  ok(await ind(a) === '1 / 1' && await cnt(a) === 0 && tl.grid.length === 1 && tl.trash.length === 1 && px[0].dark === 0, 'festgeschrieben: genau eine leere Seite, die gelöschte steht in „Gelöschte Seiten“', `${await ind(a)} striche=${await cnt(a)} Kacheln=${tl.grid.length} gelöscht=${tl.trash.length}`);
  await reload(a); await sleep(8000);
  await openOv(a); tl = await tiles(a); await a.keyboard.press('Escape');
  ok(await ind(a) === '1 / 1' && await cnt(a) === 0 && tl.grid.length === 1 && tl.trash.length === 1, '… auch nach Reload genau eine leere Seite', `${await ind(a)} striche=${await cnt(a)} Kacheln=${tl.grid.length} gelöscht=${tl.trash.length}`);

  // ── 40 Seiten: Öffnen ohne Einfrieren ──────────────────────────────────
  await line(a, 200, 200, 600, 400); await line(a, 600, 200, 200, 400);
  for (let i = 2; i <= 40; i++) { await a.click('#btn-add-page'); await sleep(140); await line(a, 150 + (i % 5) * 40, 200, 500, 250 + (i % 7) * 40); if (i % 3 === 0) await line(a, 500, 200, 200, 450); }
  await sleep(2500);
  ok(await ind(a) === '40 / 40', '40 Seiten angelegt und bezeichnet', await ind(a));
  await reload(a); await sleep(8000);
  const perf = await a.evaluate(async () => {
    // Blockaden der Oberfläche messen: Abstand zwischen zwei Timer-Durchläufen
    let last = performance.now(), maxGap = 0; const iv = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 4);
    const t0 = performance.now();
    document.getElementById('btn-page-overview').click();
    const sync = performance.now() - t0;
    const shown = !document.getElementById('pages-modal').classList.contains('hidden');
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    const frame = performance.now() - t0;
    // erste Interaktion: Tab bewegt den Fokus in der Übersicht
    const all = () => [...document.querySelectorAll('#pages-sheet .thumb[data-page]')];
    const doneAtFrame = all().filter(x => x._sig).length;
    let firstThumb = 0, visibleDone = 0;
    while (performance.now() - t0 < 15000) {
      const vis = all().filter(x => x._visible);
      if (!firstThumb && all().some(x => x._sig)) firstThumb = performance.now() - t0;
      if (vis.length && vis.every(x => x._sig)) { visibleDone = performance.now() - t0; break; }
      await new Promise(r => setTimeout(r, 10));
    }
    clearInterval(iv);
    return { sync: Math.round(sync), shown, frame: Math.round(frame), firstThumb: Math.round(firstThumb), visibleDone: Math.round(visibleDone), maxGap: Math.round(maxGap), tiles: all().length, gridTiles: document.querySelectorAll('#pages-grid .thumb[data-page]').length, doneAtFrame, doneWhenVisibleReady: all().filter(x => x._sig).length };
  });
  console.log(`MESSUNG 40 Seiten: Klick → Übersicht steht (synchron) ${perf.sync} ms · erstes Bild/erste Interaktion möglich nach ${perf.frame} ms · erste Vorschau nach ${perf.firstThumb} ms · alle sichtbaren Vorschauen nach ${perf.visibleDone} ms · längste Blockade ${perf.maxGap} ms · Vorschauen fertig: ${perf.doneWhenVisibleReady} von ${perf.tiles}`);
  ok(perf.shown && perf.gridTiles === 40 && perf.sync < 120 && perf.frame < 250 && perf.maxGap < 150, 'Übersicht mit 40 Seiten öffnet ohne spürbares Einfrieren', JSON.stringify(perf));
  ok(perf.visibleDone > 0 && perf.doneWhenVisibleReady < 40, 'Vorschauen werden träge geladen: außerhalb des Bildes noch nicht gerendert', `${perf.doneWhenVisibleReady} von ${perf.tiles}`);
  // Interaktion während des Ladens: sofort scrollen und eine Kachel am Ende öffnen
  await a.evaluate(() => { const s = document.getElementById('pages-sheet'); s.scrollTop = s.scrollHeight; });
  ok(await thumbsDone(a), 'nach dem Scrollen ans Ende werden die restlichen Vorschauen nachgeladen');
  px = await pix(a);
  ok(px.filter(x => x.dark > 0).length >= 38, 'Vorschauen der bezeichneten Seiten zeigen Striche', `${px.filter(x => x.dark > 0).length} von ${px.length}`);
  await a.click('#pages-grid .thumb:nth-child(37) .thumb-pic'); await sleep(900);
  ok(await ind(a) === '37 / 40' && await cnt(a) >= 1, 'Kachel 37 öffnet Seite 37', `${await ind(a)} striche=${await cnt(a)}`);

  // ── 360 × 740 ──────────────────────────────────────────────────────────
  await a.setViewportSize({ width: 360, height: 740 }); await sleep(800);
  await a.evaluate(() => { document.getElementById('console').style.opacity = '0'; });
  await openOv(a); await thumbsDone(a); await sleep(300);
  const m = await a.evaluate(() => { const s = document.getElementById('pages-sheet'); const r = s.getBoundingClientRect(); const cols = new Set([...document.querySelectorAll('#pages-grid .thumb')].map(x => Math.round(x.getBoundingClientRect().left))).size;
    const small = [...s.querySelectorAll('button')].filter(x => { const q = x.getBoundingClientRect(); return q.width && (q.height < 44 || q.width < 44); }).map(x => x.id || x.className);
    const out = [...s.querySelectorAll('*')].filter(x => { const q = x.getBoundingClientRect(); return q.width && (q.left < r.left - 1 || q.right > r.right + 1); }).length;
    return { page: document.documentElement.scrollWidth <= innerWidth, sheet: s.scrollWidth <= s.clientWidth, inside: r.left >= 0 && r.right <= innerWidth, cols, small, out, current: !!document.querySelector('#pages-grid .thumb.current') && (() => { const q = document.querySelector('#pages-grid .thumb.current').getBoundingClientRect(); return q.top >= r.top && q.bottom <= r.bottom; })() }; });
  ok(m.page && m.sheet && m.inside && m.out === 0, '360 × 740: Übersicht ohne horizontalen Scroll, nichts ragt hinaus', JSON.stringify(m));
  ok(m.cols === 2 && m.small.length === 0 && m.current, '360 px: zwei Spalten, alle Knöpfe mindestens 44 px, aktuelle Seite ist ins Bild gerollt', JSON.stringify(m));
  await shot(a, 'seiten-360.png');
  await a.click('#pages-grid .thumb.current + .thumb .thumb-pic'); await sleep(900);
  ok(!(await isOpen(a)) && await ind(a) === '38 / 40', '360 px: Tipp auf die nächste Kachel wechselt zur Seite 38', await ind(a));
  await a.evaluate(() => { document.getElementById('console').style.opacity = ''; });

  ok(dialogs.length === 0, 'kein nativer Dialog (confirm/alert/prompt) im gesamten Ablauf', dialogs.join(' | '));
  for (const [nm, X] of [['A', A], ['B', B]]) { const bad = X.logs.filter(l => /PAGEERROR|^error|ReferenceError|TypeError|fehlgeschlagen/.test(l) && !/User-Initiated Abort|WebRTC blockiert/.test(l)); ok(bad.length === 0, `keine Konsolenfehler ${nm}`, bad.slice(0, 8).join(' | ')); }
  if (process.env.LOGS) { console.log('--- A\n' + A.logs.slice(-40).join('\n')); console.log('--- B\n' + B.logs.slice(-40).join('\n')); }
  await browser.close();
  console.log(`Screenshots: ${OUT}`);
  console.log(fails ? `ERGEBNIS: ${fails} FEHLER` : 'ERGEBNIS: ALLES OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TESTFEHLER', e); process.exit(2); });
