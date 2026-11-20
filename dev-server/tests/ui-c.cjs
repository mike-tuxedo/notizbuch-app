// UI-Test Redesign Teil C: node ui-c.cjs <URL>
// Hinweise (Toasts) statt nativer Dialoge, „Seite leeren/löschen“ mit „Rückgängig“ über zwei Geräte
// (Geräte-Sync wie accept.cjs device), „Notizbuch beitreten“, Passphrase-Dialog, ws:// auf https.
// Schreibt Screenshots nach /tmp/notes-ui/.
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
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, ignoreHTTPSErrors: true, colorScheme: 'light', acceptDownloads: true });
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
  const both = async (label, want) => { const [x, y] = [await cnt(a), await cnt(b)]; ok(x === want && y === want, label, `A=${x} B=${y} (soll ${want})`); };
  let row = 0;
  const draw = async p => { const y = 200 + (row++ % 6) * 50; const box = await p.evaluate(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); return { x: c.x, y: c.y }; });
    await p.mouse.move(box.x + 150, box.y + y); await p.mouse.down(); for (let i = 0; i <= 20; i++) await p.mouse.move(box.x + 150 + i * 15, box.y + y); await p.mouse.up(); };
  const menu = async (p, id) => { await p.click('#btn-page-menu'); await p.click('#' + id); };
  const toast = p => p.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map(t => ({ text: t.querySelector('span').textContent, action: t.querySelector('button')?.textContent || '' })));
  const undoToast = async p => (await toast(p)).find(t => t.action === 'Rückgängig');
  const ind = p => p.evaluate(() => document.getElementById('page-indicator').textContent.trim());
  const note = p => p.evaluate(() => localStorage.getItem('notizbuch:pendingPageOp'));
  const reload = async p => { await p.reload(); await ready(p).catch(() => {}); };
  const shot = (p, name) => p.screenshot({ path: `${OUT}/${name}` });

  // ── Leeren mit „Rückgängig“ ────────────────────────────────────────────
  await draw(a); await draw(a); await draw(a); await sleep(3000);
  await both('3 Striche von A, B schaut zu', 3);
  await menu(a, 'btn-clear'); await sleep(400);
  let t = await undoToast(a);
  ok(await cnt(a) === 0 && !!t && /geleert/.test(t.text), 'Leeren: A zeigt sofort 0 und einen Hinweis mit „Rückgängig“', JSON.stringify(await toast(a)));
  ok(await a.evaluate(() => { const h = document.getElementById('toasts'); return h.getAttribute('aria-live') === 'polite' && h.querySelector('.toast button').tabIndex >= 0; }), 'Hinweis-Bereich hat aria-live="polite", „Rückgängig“ ist ein fokussierbarer Knopf');
  ok(await a.evaluate(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); const r = document.querySelector('#toasts .toast').getBoundingClientRect(); return r.bottom < c.y + 180 || r.top > c.y + 500 || r.right < c.x + 150 || r.left > c.x + 450; }), 'Hinweis liegt außerhalb des Testbereichs der Zeichenfläche (x 150..450 / y 180..500)');
  ok(await a.evaluate(() => { const r = document.querySelector('#toasts .toast').getBoundingClientRect(); return ['.pages', '.zoom'].every(s => { const e = document.querySelector(s); if (!e) return true; const q = e.getBoundingClientRect(); return r.bottom <= q.top || r.top >= q.bottom || r.right <= q.left || r.left >= q.right; }); }), 'Hinweis verdeckt die Pillen unten nicht');
  await shot(a, 'toast-leeren.png');
  let bMin = 99; for (let i = 0; i < 6; i++) { bMin = Math.min(bMin, await cnt(b)); await sleep(400); }
  ok(bMin === 3, 'in der Frist erfährt B nichts vom Leeren', `B min=${bMin}`);
  await a.click('#toasts .toast button'); await sleep(400);
  ok(await cnt(a) === 3 && !(await undoToast(a)) && await note(a) === null, '„Rückgängig“: A zeigt wieder 3, Merkzettel entfernt', `A=${await cnt(a)} ${JSON.stringify(await toast(a))}`);
  await sleep(4000); await both('nach „Rückgängig“ haben beide 3', 3);

  // Tastatur: Enter auf dem fokussierten Knopf, Strg+Z, Esc
  await menu(a, 'btn-clear'); await sleep(300);
  await a.evaluate(() => document.querySelector('#toasts .toast button').focus()); await a.keyboard.press('Enter'); await sleep(300);
  ok(await cnt(a) === 3, 'Tastatur: Enter auf „Rückgängig“ stellt wieder her', `A=${await cnt(a)}`);
  await menu(a, 'btn-clear'); await sleep(300);
  await a.evaluate(() => document.activeElement?.blur()); await a.keyboard.press('Control+z'); await sleep(300);
  ok(await cnt(a) === 3, 'Tastatur: Strg+Z nimmt das Leeren zurück (und macht keinen Strich rückgängig)', `A=${await cnt(a)}`);
  await sleep(3500); await both('nach den Tastatur-Proben haben beide weiter 3', 3);

  // Leeren und Hinweis ablaufen lassen
  await menu(a, 'btn-clear'); await sleep(7500);
  ok((await toast(a)).length === 0 && await cnt(a) === 0, 'Hinweis verschwindet von selbst, A bleibt bei 0', JSON.stringify(await toast(a)));
  await sleep(3000); await both('Leeren festgeschrieben: A und B leer', 0);
  ok(await a.evaluate(() => document.getElementById('btn-redo').disabled), 'Redo ist nach dem Leeren aus');
  await reload(b); await reload(a); await sleep(8000); await both('leer auch nach Reload beider', 0);
  await draw(a); await sleep(3000); await both('A zeichnet 1 nach dem Leeren', 1);

  // ── Seite löschen mit „Rückgängig“ ─────────────────────────────────────
  await a.click('#btn-add-page'); await sleep(3000);
  ok(await ind(a) === '2 / 2' && /\/ 2$/.test(await ind(b)), 'neue Seite: Seitenzähler bei A und B', `A=${await ind(a)} B=${await ind(b)}`);
  if (!/^2/.test(await ind(b))) { await b.click('#btn-next'); await sleep(1000); }
  await menu(a, 'btn-delete-page'); await sleep(400);
  t = await undoToast(a);
  ok(!!t && /Seite 2 gelöscht/.test(t.text) && await ind(a) === '1 / 1', 'Löschen: Hinweis „Seite 2 gelöscht“ mit „Rückgängig“, Ansicht springt auf die Nachbarseite (1 / 1)', `${JSON.stringify(await toast(a))} A=${await ind(a)}`);
  await shot(a, 'toast-loeschen.png');
  await sleep(1500);
  ok(await ind(b) === '2 / 2', 'in der Frist erfährt B nichts vom Löschen', `B=${await ind(b)}`);
  await a.click('#toasts .toast button'); await sleep(400);
  ok(await ind(a) === '2 / 2' && await note(a) === null, '„Rückgängig“ stellt die Seite wieder her und führt zu ihr zurück (A)', `A=${await ind(a)}`);
  await sleep(4000);
  ok(await ind(a) === '2 / 2' && await ind(b) === '2 / 2', 'Seitenzähler nach „Rückgängig“ bei A und B unverändert', `A=${await ind(a)} B=${await ind(b)}`);
  await menu(a, 'btn-delete-page'); await sleep(7500);
  ok((await toast(a)).length === 0 && await ind(a) === '1 / 1', 'Löschen ohne „Rückgängig“: Hinweis läuft ab, Seite bei A aus der Navigation verschwunden', `A=${await ind(a)}`);
  await sleep(4000);
  ok(await ind(a) === '1 / 1' && await ind(b) === '1 / 1', 'gelöscht bei A und B (Zähler 1 / 1, B springt auf die Nachbarseite)', `A=${await ind(a)} B=${await ind(b)}`);
  await reload(b); await reload(a); await sleep(8000);
  ok(await ind(a) === '1 / 1' && await ind(b) === '1 / 1', 'gelöscht bei A und B auch nach Reload', `A=${await ind(a)} B=${await ind(b)}`);

  // ── Leeren + sofort neuer Strich ───────────────────────────────────────
  await both('beide stehen auf Seite 1: 1 Strich', 1);
  await menu(a, 'btn-clear'); await draw(a); await sleep(400);
  ok(await cnt(a) === 1 && !(await undoToast(a)), 'neuer Strich schreibt das Leeren sofort fest (Hinweis weg, A=1)', `A=${await cnt(a)} ${JSON.stringify(await toast(a))}`);
  await sleep(4000); await both('Leeren + sofort Strich: beide genau 1', 1);
  await reload(b); await reload(a); await sleep(8000); await both('… auch nach Reload beider', 1);

  // Leeren und in der Frist neu laden: gilt als gewollt
  await menu(a, 'btn-clear'); await sleep(300); await reload(a); await sleep(8000);
  await both('Leeren + Neuladen in der Frist: beide 0', 0);
  ok(await note(a) === null, 'Merkzettel nach dem Nachholen entfernt', String(await note(a)));
  await draw(a); await sleep(3000); await both('danach 1 Strich von A', 1);

  // ── Mehrere Hinweise, Fehlermeldungen ohne nativen Dialog ──────────────
  await menu(a, 'btn-menu-export-png'); await menu(a, 'btn-menu-export-svg'); await sleep(500);
  const two = await toast(a);
  ok(two.length === 2 && /PNG/.test(two[0].text) && /SVG/.test(two[1].text), 'zwei Hinweise stapeln sich', JSON.stringify(two));
  ok(await a.evaluate(() => { const r = [...document.querySelectorAll('#toasts .toast')].map(e => e.getBoundingClientRect()); return r.length === 2 && r[0].bottom <= r[1].top; }), 'gestapelte Hinweise überlappen sich nicht');
  await sleep(3500);
  ok((await toast(a)).length === 0, 'Hinweise ohne Aktion verschwinden nach kurzer Zeit');

  // ── „Notizbuch beitreten“ in der Schublade ─────────────────────────────
  const shared = () => a.evaluate(() => ({ ls: localStorage.getItem('notizbuch:sharedNotebooks'), badge: document.querySelectorAll('#notebook-list .badge').length, ov: (document.getElementById('console').innerText.match(/shared: [^\n]*/) || [''])[0] }));
  const before = await shared();
  await a.click('#btn-notebooks'); await sleep(300);
  ok(await a.evaluate(() => { const add = document.getElementById('btn-add-notebook'); return add.nextElementSibling?.id === 'btn-join-notebook' && /Notizbuch beitreten/.test(add.nextElementSibling.textContent); }), '„Notizbuch beitreten“ steht direkt unter „Neues Notizbuch“');
  await a.click('#btn-join-notebook'); await sleep(1500);
  ok(await a.evaluate(() => !document.getElementById('share-modal').classList.contains('hidden') && document.getElementById('share-tab-join').getAttribute('aria-selected') === 'true' && !document.getElementById('share-panel-join').hidden && document.getElementById('share-panel-invite').hidden && document.activeElement?.id === 'join-link'), '„Notizbuch beitreten“ öffnet den Reiter „Beitreten“, Fokus im Link-Feld');
  const mid = await shared();
  ok(mid.badge === 0 && (!mid.ls || mid.ls === '[]') && mid.ls === before.ls && await a.evaluate(() => document.getElementById('share-link').value === ''), 'aktuelles Notizbuch wird dabei nicht als geteilt markiert', JSON.stringify(mid));
  await a.click('#share-tab-invite'); await sleep(1500);
  const after = await shared();
  ok(after.badge === 1 && /#nb-/.test(await a.evaluate(() => document.getElementById('share-link').value)), 'erst der Reiter „Einladen“ markiert es als geteilt und füllt #share-link', JSON.stringify(after));
  await a.keyboard.press('Escape'); await sleep(300);

  // ── ws:// auf https (Funktion mit simuliertem Host; gegen localhost in der UI nicht prüfbar) ──
  const rp = await a.evaluate(async () => { const m = await import('/js/relay.js'); const f = m.relayUrlProblem; const https = { protocol: 'https:', hostname: 'notes.example.org' };
    return { wsHttps: f('ws://relay.example.org', https), wssHttps: f('wss://relay.example.org', https), wsLocalTarget: f('ws://localhost:4999', https), wsLoopTarget: f('ws://127.0.0.1:4999', https), wsHttp: f('ws://relay.example.org', { protocol: 'http:', hostname: 'notes.example.org' }), wsLocalPage: f('ws://relay.example.org', { protocol: 'https:', hostname: 'localhost' }) }; });
  ok(/https/.test(rp.wsHttps) && /wss:\/\//.test(rp.wsHttps), 'relayUrlProblem: ws:// auf https-Seite wird mit Meldung abgelehnt', rp.wsHttps);
  ok(rp.wssHttps === '' && rp.wsLocalTarget === '' && rp.wsLoopTarget === '' && rp.wsHttp === '' && rp.wsLocalPage === '', 'relayUrlProblem: wss://, localhost/127.0.0.1 und http-Seiten bleiben erlaubt', JSON.stringify(rp));

  // ── Passphrase-Dialog beim Import ──────────────────────────────────────
  await a.click('#btn-notebooks'); await sleep(300); await a.click('#btn-settings'); await sleep(300); await a.click('#set-tab-data'); await sleep(300);
  const [chooser] = await Promise.all([a.waitForEvent('filechooser'), a.click('#btn-import')]);
  await chooser.setFiles({ name: 'sicherung.enc', mimeType: 'application/octet-stream', buffer: Buffer.alloc(200, 7) });
  await a.waitForSelector('#prompt-modal:not(.hidden)', { timeout: 5000 }).catch(() => {});
  ok(await a.evaluate(() => { const m = document.getElementById('prompt-modal'); const i = document.getElementById('prompt-input'); const d = m.querySelector('[role="dialog"]'); return !m.classList.contains('hidden') && i.type === 'password' && document.activeElement === i && d.getAttribute('aria-modal') === 'true' && !!document.getElementById(d.getAttribute('aria-labelledby')).textContent && document.elementFromPoint(innerWidth / 2, i.getBoundingClientRect().top + 5)?.closest('#prompt-modal') === m; }), 'Import fragt die Passphrase in einem eigenen Dialog (type=password, Fokus im Feld, liegt über den Einstellungen)');
  await sleep(300); await shot(a, 'dialog-passphrase.png');
  await a.fill('#prompt-input', 'falsch'); await a.keyboard.press('Enter'); await sleep(1500);
  ok(await a.evaluate(() => !document.getElementById('prompt-modal').classList.contains('hidden') && document.getElementById('prompt-error').textContent.length > 10 && document.getElementById('prompt-input').getAttribute('aria-invalid') === 'true'), 'falsche Passphrase/Datei: Fehlermeldung am Feld, Dialog bleibt offen', await a.evaluate(() => document.getElementById('prompt-error').textContent));
  await a.keyboard.press('Escape'); await sleep(300);
  ok(await a.evaluate(() => document.getElementById('prompt-modal').classList.contains('hidden') && !document.getElementById('settings-modal').classList.contains('hidden')), 'Esc schließt nur den Passphrase-Dialog, Einstellungen bleiben offen');
  await a.keyboard.press('Escape'); await sleep(300);

  // ── Screenshots: dunkel und 360 px ─────────────────────────────────────
  await a.click('#btn-notebooks'); await sleep(300); await a.click('#btn-settings'); await sleep(300); await a.click('#set-tab-general'); await a.click('#theme-seg [data-choice="dark"]'); await sleep(300); await a.keyboard.press('Escape'); await sleep(300);
  await menu(a, 'btn-clear'); await sleep(400); await shot(a, 'toast-dark.png');
  ok(await a.evaluate(() => { const s = getComputedStyle(document.querySelector('#toasts .toast')); return document.documentElement.dataset.theme === 'dark' && s.backgroundColor === 'rgb(243, 245, 248)'; }), 'dunkel: Hinweis nutzt die Tokens (heller Grund, dunkle Schrift)');
  await a.click('#toasts .toast button'); await sleep(300);
  await a.setViewportSize({ width: 360, height: 740 }); await sleep(800);
  await menu(a, 'btn-clear'); await sleep(400);
  // Diagnose-Overlay nur für dieses Bild ausblenden (es würde bei 360 px alles verdecken)
  await a.evaluate(() => { document.getElementById('console').style.opacity = '0'; }); await shot(a, 'toast-360.png'); await a.evaluate(() => { document.getElementById('console').style.opacity = ''; });
  ok(await a.evaluate(() => { const r = document.querySelector('#toasts .toast').getBoundingClientRect(); const free = sel => [...document.querySelectorAll(sel)].every(e => { const q = e.getBoundingClientRect(); return !q.width || r.bottom <= q.top || r.top >= q.bottom || r.right <= q.left || r.left >= q.right; }); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth && free('.pages') && free('.zoom') && free('.toolrow'); }), '360 px: Hinweis passt ins Bild und verdeckt weder Pillen noch Werkzeugreihe');
  await a.click('#toasts .toast button'); await sleep(300);
  ok(await cnt(a) === 1, 'nach den Screenshots unverändert 1 Strich bei A', `A=${await cnt(a)}`);

  ok(dialogs.length === 0, 'kein nativer Dialog (confirm/alert/prompt) im gesamten Ablauf', dialogs.join(' | '));
  for (const [nm, X] of [['A', A], ['B', B]]) { const bad = X.logs.filter(l => /PAGEERROR|^error|ReferenceError|TypeError|fehlgeschlagen/.test(l) && !/User-Initiated Abort|WebRTC blockiert/.test(l)); ok(bad.length === 0, `keine Konsolenfehler ${nm}`, bad.slice(0, 8).join(' | ')); }
  if (process.env.LOGS) { console.log('--- A\n' + A.logs.slice(-40).join('\n')); console.log('--- B\n' + B.logs.slice(-40).join('\n')); }
  await browser.close();
  console.log(`Screenshots: ${OUT}`);
  console.log(fails ? `ERGEBNIS: ${fails} FEHLER` : 'ERGEBNIS: ALLES OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TESTFEHLER', e); process.exit(2); });
