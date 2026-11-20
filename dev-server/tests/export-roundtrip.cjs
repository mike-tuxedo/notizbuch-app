// Test Sicherung Export/Import: node export-roundtrip.cjs <URL>
// A legt zwei Notizbücher an und exportiert mit Passphrase (notizbuch-backup-v3: Schlüssel + Inhalt).
// Fall a) Gerät ohne Schlüssel spielt die Datei aus dem Erststart-Dialog ein.
// Fall b) Gerät mit demselben Schlüssel mischt (Relay blockiert — die Daten kommen aus der Datei).
// Fall c) Gerät mit anderem Schlüssel ersetzt nach Rückfrage.
// Dazu: falsche/zu kurze/ungleiche Passphrase, Altformat v2 (im Test nachgebaut), keine nativen
// Dialoge, keine Konsolenfehler. WebRTC ist in diesem Test immer blockiert.
// Endet mit 'ERGEBNIS: ALLES OK' (Exit 0) oder 'ERGEBNIS: n FEHLER' (Exit 1).
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('fs');
const URL = process.argv[2] || 'https://localhost:4444/app.html';
const OUT = process.env.OUT || '/tmp/notes-ui';
const FILE1 = `${OUT}/notizbuch-backup-1.enc`, FILE2 = `${OUT}/notizbuch-backup-2.enc`, FILE_V2 = `${OUT}/notizbuch-backup-v2.enc`;
// Wegwerf-Passphrasen nur für diesen Test
const PASS = 'Test-Passphrase-4711', WRONG = 'ganz-falsche-Passphrase';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (cond, label, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${extra !== '' ? ' — ' + extra : ''}`); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--ignore-certificate-errors'] });
  const all = [];
  const mk = async (name, { blockRelay = false } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, ignoreHTTPSErrors: true, acceptDownloads: true, colorScheme: 'light' });
    await ctx.addInitScript(() => localStorage.setItem('notizbuch:debugOverlay', '1'));
    await ctx.addInitScript(() => { RTCPeerConnection.prototype.setRemoteDescription = () => Promise.reject(new Error('WebRTC blockiert (Test)')); });
    const X = { name, ctx, logs: [], dialogs: [], downloads: 0, blocked: 0 };
    if (blockRelay) await ctx.routeWebSocket(/^wss?:\/\/localhost:4444/, ws => { X.blocked++; ws.close({ code: 1011, reason: 'Relay blockiert (Test)' }); });
    X.page = await ctx.newPage();
    X.page.on('console', m => { const t = m.text(); if (!/WebSocket connection|willReadFrequently|Password field|WebRTC blockiert/.test(t)) X.logs.push(`${m.type()}: ${t.slice(0, 220)}`); });
    X.page.on('pageerror', e => X.logs.push('PAGEERROR ' + String(e).slice(0, 300)));
    X.page.on('dialog', d => { X.dialogs.push(`${d.type()}: ${d.message().slice(0, 120)}`); d.dismiss().catch(() => {}); });
    X.page.on('download', () => { X.downloads++; });
    all.push(X);
    return X;
  };
  const ready = p => p.waitForFunction(() => /device: [0-9a-f]/.test(document.getElementById('console')?.innerText || ''), null, { timeout: 25000 });
  const fresh = async X => { await X.page.goto(URL); await X.page.click('#btn-new-start'); await X.page.click('#btn-key-confirmed'); await ready(X.page); await sleep(2500); };
  const reload = async p => { await p.reload(); await ready(p); await sleep(2000); };
  const ovl = p => p.evaluate(() => { const m = (document.getElementById('console')?.innerText || '').match(/striche: (\d+) \(events: (\d+)\)/); return m ? { s: Number(m[1]), e: Number(m[2]) } : { s: -1, e: -1 }; });
  const cnt = async p => (await ovl(p)).s;
  const ind = p => p.evaluate(() => document.getElementById('page-indicator').textContent.trim());
  const keyHash = p => p.evaluate(() => localStorage.getItem('notizbuch:masterKeyHash'));
  const keyHex = p => p.evaluate(() => JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw')).map(x => x.toString(16).padStart(2, '0')).join(''));
  const names = p => p.evaluate(() => [...document.querySelectorAll('#notebook-list > * .nb-name')].map(e => e.textContent));
  const toasts = p => p.evaluate(() => [...document.querySelectorAll('#toasts .toast span')].map(e => e.textContent));
  const shot = (p, name) => p.screenshot({ path: `${OUT}/${name}` });
  const hidden = (p, id) => p.evaluate(i => document.getElementById(i).classList.contains('hidden'), id);
  const drawerOpen = p => p.evaluate(() => document.querySelector('.sidebar').classList.contains('sidebar-open'));
  const openDrawer = async p => { if (!(await drawerOpen(p))) { await p.click('#btn-notebooks'); await sleep(300); } };
  const closeDrawer = async p => { if (await drawerOpen(p)) { await p.keyboard.press('Escape'); await sleep(300); } };
  const closeAll = async p => { for (let i = 0; i < 4; i++) { if (await p.evaluate(() => !!document.querySelector('.modal-overlay:not(.hidden)'))) { await p.keyboard.press('Escape'); await sleep(200); } } await closeDrawer(p); };
  let y = 100;
  const draw = async p => { y = y > 520 ? 160 : y + 60; const box = await p.evaluate(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); return { x: c.x, y: c.y }; });
    await p.mouse.move(box.x + 150, box.y + y); await p.mouse.down(); for (let i = 0; i <= 16; i++) await p.mouse.move(box.x + 150 + i * 15, box.y + y); await p.mouse.up(); await sleep(250); };
  const mark = async (p, name) => p.evaluate(n => { document.querySelectorAll('[data-t]').forEach(e => delete e.dataset.t); const row = [...document.querySelectorAll('#notebook-list > *')].find(r => r.querySelector('.nb-name').textContent === n); if (!row) return false; row.scrollIntoView({ block: 'nearest' }); row.dataset.t = '1'; return true; }, name);
  const rename = async (p, from, to) => { await openDrawer(p); await mark(p, from); await p.click('#notebook-list > [data-t="1"] .nb-more'); await sleep(150); await p.click('#nb-menu-rename'); await p.fill('.rename-input', to); await p.keyboard.press('Enter'); await sleep(500); await closeDrawer(p); };
  const selectNb = async (p, name) => { await openDrawer(p); if (!(await mark(p, name))) throw new Error('Notizbuch fehlt: ' + name); await p.click('#notebook-list > [data-t="1"] .nb-select'); await sleep(700); await closeDrawer(p); };
  const toFirstPage = async p => { for (let i = 0; i < 60 && !/^1 \//.test(await ind(p)); i++) { await p.click('#btn-prev'); await sleep(350); } };
  const trash = async p => { await p.click('#btn-page-overview'); await sleep(300); const r = await p.evaluate(() => ({ grid: document.querySelectorAll('#pages-grid .thumb[data-page]').length, trash: document.querySelectorAll('#pages-trash .thumb[data-page]').length, btn: document.querySelector('#pages-trash [data-restore]')?.textContent.trim() || '' })); await p.keyboard.press('Escape'); await sleep(250); return r; };
  /** Zustand aller genannten Notizbücher: je Seite Striche, Events, Papierart; dazu Zahl gelöschter Seiten. */
  const snapshot = async (p, nbNames) => {
    const out = {};
    for (const n of nbNames) {
      await selectNb(p, n); await toFirstPage(p);
      const total = Number((await ind(p)).split('/')[1]); const pages = [];
      for (let i = 0; i < total; i++) {
        await sleep(350);
        const o = await ovl(p);
        pages.push(`${o.s}/${o.e}/${await p.evaluate(() => document.querySelector('.bg-btn[aria-pressed="true"]')?.dataset.bg || '?')}`);
        if (i < total - 1) { await p.click('#btn-next'); }
      }
      const t = await trash(p);
      out[n] = { pages, geloescht: t.trash, btn: t.btn };
    }
    return JSON.stringify(out);
  };
  const dataTab = async p => { if (await hidden(p, 'settings-modal')) { await openDrawer(p); await p.click('#btn-settings'); await sleep(300); } await p.click('#set-tab-data'); await sleep(300); };
  const startImport = async (p, file, btn = '#btn-import') => { const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 10000 }), p.click(btn)]); await chooser.setFiles(file); };
  const promptOpen = p => p.waitForSelector('#prompt-modal:not(.hidden)', { timeout: 6000 }).then(() => true).catch(() => false);
  const enterPass = async (p, pass) => { await p.fill('#prompt-input', pass); await p.keyboard.press('Enter'); };
  const promptError = p => p.evaluate(() => document.getElementById('prompt-error').textContent);
  const waitToast = (p, re, ms = 20000) => p.waitForFunction(src => [...document.querySelectorAll('#toasts .toast span')].some(e => new RegExp(src).test(e.textContent)), re.source, { timeout: ms }).then(() => true).catch(() => false);
  const leak = p => p.evaluate(([a, b]) => { const all = JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage)) + document.body.innerText + [...document.querySelectorAll('input')].map(i => i.value).join('|'); return all.includes(a) || all.includes(b); }, [PASS, WRONG]);
  const exportTo = async (p, file, pass) => {
    await dataTab(p); await p.click('#btn-export-enc'); await p.waitForSelector('#backup-export-modal:not(.hidden)');
    await p.fill('#export-pass', pass); await p.fill('#export-pass2', pass);
    const [download] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.click('#export-ok')]);
    await download.saveAs(file); await sleep(500);
    return download.suggestedFilename();
  };

  // ══ A: zwei Notizbücher anlegen ═════════════════════════════════════════
  const A = await mk('A'); const a = A.page; await fresh(A);
  await rename(a, (await names(a))[0], 'Alpha');
  await draw(a);                                                     // Alpha S1: 1 Strich
  await a.click('#btn-add-page'); await sleep(600);                  // Alpha S2
  await draw(a); await draw(a); await draw(a);
  await a.click('button[title="Rückgängig"]'); await sleep(300);     // Strich 3 weg
  await a.click('button[title="Rückgängig"]'); await sleep(300);     // Strich 2 weg
  await a.click('#btn-redo'); await sleep(300);                      // Strich 2 wieder da
  ok(await ind(a) === '2 / 2' && (await ovl(a)).s === 2 && (await ovl(a)).e === 6, 'A: Alpha Seite 2 — 3 Striche, einer per Undo entfernt, einer per Undo+Redo zurück (2 Striche, 6 Events)', `${await ind(a)} ${JSON.stringify(await ovl(a))}`);
  await sleep(1500);
  await openDrawer(a); await a.click('#btn-add-notebook'); await sleep(1200); await closeDrawer(a);
  await rename(a, 'Neues Notizbuch', 'Beta');
  await draw(a); await sleep(1500);                                  // Beta S1: 1 Strich
  await selectNb(a, 'Alpha');
  await a.click('#btn-add-page'); await sleep(600);                  // Alpha S3
  await draw(a); await sleep(1300);
  ok(await ind(a) === '3 / 3', 'A: Alpha hat 3 Seiten', await ind(a));
  // Papierart nur von Seite 1 ändern (neue Seiten erben die Papierart, deshalb erst jetzt)
  await toFirstPage(a);
  await a.click('#btn-page-menu'); await a.click('.bg-btn[data-bg="lined"]'); await sleep(300); await a.keyboard.press('Escape'); await sleep(1300);
  await a.click('#btn-next'); await sleep(400); await a.click('#btn-next'); await sleep(400);
  ok(await ind(a) === '3 / 3' && await cnt(a) === 1, 'A: wieder auf Seite 3 (1 Strich)', `${await ind(a)} ${await cnt(a)}`);
  await a.click('#btn-page-menu'); await a.click('#btn-delete-page'); await sleep(500);
  ok(await ind(a) === '2 / 2' && (await toasts(a)).some(t => /gelöscht/.test(t)), 'A: Seite 3 gelöscht (Hinweis mit Frist läuft noch — der Export schreibt es fest)', `${await ind(a)} ${JSON.stringify(await toasts(a))}`);

  // ══ Export: Dialog, Ablehnungen, Datei ═══════════════════════════════════
  await dataTab(a); await shot(a, 'daten-schluessel.png');
  ok(/Passphrase/.test(await a.evaluate(() => document.getElementById('set-panel-data').innerText)) && /Schlüssel und alle Notizbücher/.test(await a.evaluate(() => document.getElementById('set-panel-data').innerText)), 'Daten & Schlüssel nennt Inhalt der Sicherung und die Passphrase');
  await a.click('#btn-export-enc'); await a.waitForSelector('#backup-export-modal:not(.hidden)', { timeout: 5000 }).catch(() => {});
  ok(await a.evaluate(() => { const m = document.getElementById('backup-export-modal'); const p1 = document.getElementById('export-pass'), p2 = document.getElementById('export-pass2'); return !m.classList.contains('hidden') && p1.type === 'password' && p2.type === 'password' && document.activeElement === p1 && /nicht wiederherstellen/.test(m.innerText) && document.elementFromPoint(innerWidth / 2, p1.getBoundingClientRect().top + 5)?.closest('#backup-export-modal') === m; }), 'Export öffnet eigenen Dialog: zwei Passwortfelder, Fokus im ersten, Hinweis „nicht wiederherstellbar“, liegt über den Einstellungen');
  await a.fill('#export-pass', 'kurz123'); await a.fill('#export-pass2', 'kurz123'); await a.click('#export-ok'); await sleep(600);
  ok(!(await hidden(a, 'backup-export-modal')) && /mindestens 8/.test(await a.evaluate(() => document.getElementById('export-error').textContent)) && A.downloads === 0, 'zu kurze Passphrase (7 Zeichen) wird abgelehnt, keine Datei', await a.evaluate(() => document.getElementById('export-error').textContent));
  await a.fill('#export-pass', PASS); await a.fill('#export-pass2', PASS + 'x'); await a.click('#export-ok'); await sleep(600);
  ok(!(await hidden(a, 'backup-export-modal')) && /stimmen nicht überein/.test(await a.evaluate(() => document.getElementById('export-error').textContent)) && A.downloads === 0, 'ungleiche Wiederholung wird abgelehnt, keine Datei', await a.evaluate(() => document.getElementById('export-error').textContent));
  await shot(a, 'export-dialog.png');
  await a.keyboard.press('Escape'); await sleep(300);
  ok(await hidden(a, 'backup-export-modal') && !(await hidden(a, 'settings-modal')) && await a.evaluate(() => document.getElementById('export-pass').value === '' && document.getElementById('export-pass2').value === ''), 'Esc schließt nur den Export-Dialog; Felder sind geleert');
  const fname = await exportTo(a, FILE1, PASS);
  const bytes1 = fs.readFileSync(FILE1);
  ok(fname === 'notizbuch-backup.enc' && bytes1.length > 500 && A.downloads === 1 && (await toasts(a)).some(t => /Sicherung exportiert/.test(t)), 'Export mit Passphrase liefert notizbuch-backup.enc', `${fname}, ${bytes1.length} Bytes`);
  ok(await hidden(a, 'backup-export-modal') && await a.evaluate(() => document.getElementById('export-pass').value === '' && document.getElementById('export-pass2').value === '') && !(await leak(a)), 'nach dem Export: Felder leer, Passphrase weder in Hinweisen noch in localStorage/sessionStorage');
  // Inhalt der Datei prüfen (mit der Passphrase geöffnet)
  const inside = await a.evaluate(async ([arr, pass]) => {
    const share = await import('/js/share.js'); const enc = await import('/js/encryption.js');
    const obj = await share.unpackBackup(new Uint8Array(arr), pass);
    let mitGeraeteschluessel = false;
    try { await enc.decrypt(await enc.importKey(new Uint8Array(JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw'))), true), new Uint8Array(arr)); mitGeraeteschluessel = true; } catch {}
    const alpha = obj.notebooks.find(n => n.name === 'Alpha');
    return { type: obj.type, felder: Object.keys(obj).sort().join(','), masterOk: JSON.stringify(obj.masterKey) === localStorage.getItem('notizbuch:masterKeyRaw'), nbKeys: Object.keys(obj.notebookKeys).length, shared: Array.isArray(obj.sharedNotebooks),
      nb: obj.notebooks.map(n => `${n.name}:${n.pages.length}`).join(','), typen: alpha.pages.map(p => p.events.map(e => e.type[0]).join('')).join('|'), meta: Object.keys(alpha.pages[0]).sort().join(','),
      geloescht: alpha.pages.filter(p => p.deletedAt > (p.restoredAt || 0)).length, bg: alpha.pages.map(p => p.background).join(','), lokal: /theme|iceSettings|relayUrl|penOnly|turn/i.test(JSON.stringify(Object.keys(obj))), mitGeraeteschluessel };
  }, [[...bytes1], PASS]);
  ok(inside.type === 'notizbuch-backup-v3' && inside.masterOk && inside.nbKeys === 2 && inside.shared && inside.nb === 'Alpha:3,Beta:1' && !inside.lokal && !inside.mitGeraeteschluessel, 'Datei: Typ v3, MasterKey, 2 NotebookKeys, Liste geteilter Notizbücher, beide Notizbücher; keine gerätelokalen Einstellungen; nicht mit dem bloßen Geräteschlüssel lesbar', JSON.stringify({ ...inside, typen: undefined, meta: undefined }));
  ok(/^s\|/.test(inside.typen) && inside.typen.split('|')[1].split('').sort().join('') === 'rsssuu' && inside.geloescht === 1 && inside.bg === 'lined,grid,grid' && inside.meta === 'background,clearedAt,createdAt,deletedAt,events,id,order,restoredAt', 'Datei: vollständiges Event-Log (3 stroke, 2 undo, 1 redo auf Seite 2), Seiten-Meta komplett, vorgemerktes Löschen festgeschrieben', `${inside.typen} / ${inside.meta} / gelöscht=${inside.geloescht} / ${inside.bg}`);
  await closeAll(a); await sleep(500);
  const hashA = await keyHash(a), hexA = await keyHex(a), namesA = await names(a);
  const snapA1 = await snapshot(a, ['Alpha', 'Beta']);
  ok(snapA1 === JSON.stringify({ Alpha: { pages: ['1/1/lined', '2/6/grid'], geloescht: 1, btn: 'Wiederherstellen' }, Beta: { pages: ['1/1/grid'], geloescht: 0, btn: '' } }), 'A: Soll-Zustand (Alpha: 2 Seiten + 1 gelöschte, Seite 1 liniert; Beta: 1 Seite)', snapA1);

  // ══ Fall a) Gerät ohne Schlüssel, aus dem Erststart-Dialog ═══════════════
  const C = await mk('C', { blockRelay: true }); const c = C.page;
  await c.goto(URL); await c.waitForSelector('#firststart-modal:not(.hidden)');
  ok(await c.evaluate(() => { const b = document.getElementById('btn-restore-backup'); return !!b && b.getClientRects().length > 0 && /Sicherung einspielen/.test(b.textContent); }), 'a) Erststart bietet „Sicherung einspielen“');
  await startImport(c, FILE1, '#btn-restore-backup');
  ok(await promptOpen(c) && await c.evaluate(() => { const i = document.getElementById('prompt-input'); return i.type === 'password' && document.activeElement === i; }), 'a) nach der Dateiwahl fragt ein Dialog die Passphrase ab (type=password)');
  await shot(c, 'import-passphrase.png');
  await enterPass(c, WRONG); await sleep(2500);
  ok(!(await hidden(c, 'prompt-modal')) && /falsche Passphrase/.test(await promptError(c)) && await keyHash(c) === null, 'a) falsche Passphrase: Meldung am Feld, kein Schlüssel installiert', await promptError(c));
  await enterPass(c, PASS);
  await c.waitForFunction(h => localStorage.getItem('notizbuch:masterKeyHash') === h, hashA, { timeout: 20000 }).catch(() => {});
  await ready(c).catch(() => {});
  const toastC = await waitToast(c, /^Sicherung eingespielt: 2 Notizbücher, 3 Seiten$/, 8000);
  await sleep(2500);
  ok(await keyHash(c) === hashA && C.blocked > 0, 'a) masterKeyHash identisch zu A (Relay blockiert — Daten kommen aus der Datei)', `blockiert=${C.blocked}`);
  ok(toastC, 'a) Hinweis „Sicherung eingespielt: 2 Notizbücher, 3 Seiten“ nach dem Neuladen');
  ok(JSON.stringify(await names(c)) === JSON.stringify(namesA), 'a) gleiche Notizbuchnamen in gleicher Reihenfolge', JSON.stringify(await names(c)));
  let snapC = await snapshot(c, ['Alpha', 'Beta']);
  ok(snapC === snapA1, 'a) Seitenzahl, Strichzahlen, Events (Undo/Redo-Zustand), Papierart wie bei A; gelöschte Seite weiter gelöscht und wiederherstellbar', snapC);
  ok(!(await leak(c)), 'a) Passphrase steht nirgends (Hinweise, Felder, localStorage/sessionStorage)');
  await reload(c);
  snapC = await snapshot(c, ['Alpha', 'Beta']);
  ok(snapC === snapA1 && await keyHash(c) === hashA, 'a) nach Reload unverändert', snapC);
  // Undo-Zustand ist echt: Undo nimmt auf Seite 2 den nächsten Strich, die gelöschte Seite lässt sich wiederherstellen
  await selectNb(c, 'Alpha'); await toFirstPage(c); await c.click('#btn-next'); await sleep(500);
  await c.click('button[title="Rückgängig"]'); await sleep(400);
  ok((await ovl(c)).s === 1 && (await ovl(c)).e === 7, 'a) Undo arbeitet auf dem eingespielten Event-Log weiter (1 Strich, 7 Events)', JSON.stringify(await ovl(c)));
  await c.click('#btn-page-overview'); await sleep(300); await c.click('#pages-trash [data-restore]'); await sleep(700); await c.keyboard.press('Escape'); await sleep(300);
  ok(/\/ 3$/.test(await ind(c)), 'a) gelöschte Seite in der Übersicht wiederhergestellt → 3 Seiten', await ind(c));

  // ══ Fall b) derselbe Schlüssel, Relay blockiert ══════════════════════════
  const D = await mk('D', { blockRelay: true }); const d = D.page;
  await d.goto(URL + '#' + hexA); await ready(d); await sleep(2500);
  const ownName = (await names(d))[0];
  ok(await keyHash(d) === hashA && D.blocked > 0 && (await names(d)).length === 1 && !['Alpha', 'Beta'].includes(ownName), 'b) D hat denselben Schlüssel, aber (Relay blockiert) nur ein eigenes Notizbuch', JSON.stringify(await names(d)));
  await draw(d); await sleep(1500);
  await dataTab(d); await startImport(d, FILE1);
  ok(await promptOpen(d), 'b) Import fragt die Passphrase ab');
  await enterPass(d, WRONG); await sleep(2500);
  ok(!(await hidden(d, 'prompt-modal')) && /falsche Passphrase/.test(await promptError(d)) && (await names(d)).length === 1, 'b) falsche Passphrase: Meldung am Feld, nichts verändert', await promptError(d));
  await enterPass(d, PASS);
  ok(await waitToast(d, /^Sicherung eingespielt: 2 Notizbücher, 3 Seiten$/), 'b) Hinweis „Sicherung eingespielt: 2 Notizbücher, 3 Seiten“ (ohne Neuladen, ohne Rückfrage)', JSON.stringify(await toasts(d)));
  ok(await hidden(d, 'confirm-modal') && await keyHash(d) === hashA, 'b) keine Rückfrage, Schlüssel unverändert');
  await closeAll(d); await sleep(800);
  ok(JSON.stringify((await names(d)).slice().sort()) === JSON.stringify(['Alpha', 'Beta', ownName].sort()), 'b) eigenes Notizbuch bleibt, Alpha und Beta kommen dazu', JSON.stringify(await names(d)));
  let snapD = await snapshot(d, ['Alpha', 'Beta']);
  ok(snapD === snapA1, 'b) Alpha/Beta wie bei A', snapD);
  await selectNb(d, ownName);
  ok(await cnt(d) === 1, 'b) eigener Strich im eigenen Notizbuch bleibt', String(await cnt(d)));
  // D zeichnet selbst auf Alpha S1; A zeichnet dort ebenfalls und exportiert erneut → Vereinigung
  await selectNb(d, 'Alpha'); await toFirstPage(d); await draw(d); await sleep(1500);
  ok(await cnt(d) === 2, 'b) D: eigener zusätzlicher Strich auf Alpha Seite 1 (2)', String(await cnt(d)));
  await selectNb(a, 'Alpha'); await toFirstPage(a); await draw(a); await sleep(1500);
  await exportTo(a, FILE2, PASS); await closeAll(a);
  const snapA2 = await snapshot(a, ['Alpha', 'Beta']);
  const union = JSON.stringify({ Alpha: { pages: ['3/3/lined', '2/6/grid'], geloescht: 1, btn: 'Wiederherstellen' }, Beta: { pages: ['1/1/grid'], geloescht: 0, btn: '' } });
  await dataTab(d); await d.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
  await startImport(d, FILE2); await promptOpen(d); await enterPass(d, PASS);
  await waitToast(d, /^Sicherung eingespielt/); await closeAll(d); await sleep(800);
  snapD = await snapshot(d, ['Alpha', 'Beta']);
  ok(snapD === union, 'b) Vereinigung: Strich aus der Datei + eigener Strich (Alpha S1: 3), Rest unverändert', snapD);
  await dataTab(d); await d.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
  await startImport(d, FILE2); await promptOpen(d); await enterPass(d, PASS);
  await waitToast(d, /^Sicherung eingespielt/); await closeAll(d); await sleep(800);
  snapD = await snapshot(d, ['Alpha', 'Beta']);
  ok(snapD === union && (await names(d)).length === 3, 'b) zweites Einspielen verdoppelt nichts (Striche, Events, Notizbücher)', snapD);
  await sleep(1500); await reload(d);
  snapD = await snapshot(d, ['Alpha', 'Beta']);
  ok(snapD === union, 'b) nach Reload unverändert (gespeichert)', snapD);

  // ══ Fall c) anderer Schlüssel ════════════════════════════════════════════
  const E = await mk('E'); const e = E.page; await fresh(E);
  const hashE = await keyHash(e), nameE = (await names(e))[0];
  await draw(e); await draw(e); await sleep(1500);
  const opfs = p => p.evaluate(async () => { try { const root = await navigator.storage.getDirectory(); const nb = await root.getDirectoryHandle('notebooks'); const out = []; for await (const [n] of nb.entries()) out.push(n); return out; } catch { return []; } });
  const dirsBefore = await opfs(e);
  await dataTab(e); await startImport(e, FILE2); await promptOpen(e); await enterPass(e, PASS);
  const asked = await e.waitForSelector('#confirm-modal:not(.hidden)', { timeout: 15000 }).then(() => true).catch(() => false);
  const ctext = await e.evaluate(() => document.getElementById('confirm-title').textContent + ' ' + document.getElementById('confirm-text').textContent);
  ok(asked && /ersetz/.test(ctext) && /Schlüssel/.test(ctext) && /Verloren geht/.test(ctext) && await e.evaluate(() => document.getElementById('confirm-ok').textContent === 'Ersetzen'), 'c) Rückfrage erscheint: Schlüssel und lokale Notizbücher werden ersetzt, was verloren geht', ctext);
  await shot(e, 'import-ersetzen-rueckfrage.png');
  await e.click('#confirm-cancel'); await sleep(800);
  ok(await keyHash(e) === hashE && JSON.stringify(await names(e)) === JSON.stringify([nameE]) && await cnt(e) === 2 && JSON.stringify(await opfs(e)) === JSON.stringify(dirsBefore), 'c) Abbrechen ändert nichts (Schlüssel, Notizbuch, Striche, Dateien)', `${JSON.stringify(await names(e))} striche=${await cnt(e)}`);
  await startImport(e, FILE2); await promptOpen(e); await enterPass(e, PASS);
  await e.waitForSelector('#confirm-modal:not(.hidden)', { timeout: 15000 }).catch(() => {});
  await e.click('#confirm-ok');
  await e.waitForFunction(h => localStorage.getItem('notizbuch:masterKeyHash') === h, hashA, { timeout: 20000 }).catch(() => {});
  await ready(e).catch(() => {});
  ok(await waitToast(e, /^Sicherung eingespielt: 2 Notizbücher, 3 Seiten$/, 8000), 'c) Hinweis „Sicherung eingespielt: 2 Notizbücher, 3 Seiten“ nach dem Neuladen');
  await sleep(3000);
  ok(await keyHash(e) === hashA && JSON.stringify((await names(e)).slice().sort()) === '["Alpha","Beta"]', 'c) Bestätigen ersetzt: Schlüssel von A, nur die Notizbücher aus der Sicherung', JSON.stringify(await names(e)));
  let snapE = await snapshot(e, ['Alpha', 'Beta']);
  ok(snapE === snapA2, 'c) Inhalt wie bei A', `${snapE} (A: ${snapA2})`);
  const left = await e.evaluate(() => ({ nbKeys: Object.keys(localStorage).filter(k => k.startsWith('notizbuch:nbKey:')).length, pending: localStorage.getItem('notizbuch:pendingPageOp') }));
  const dirsAfter = await opfs(e);
  ok(dirsAfter.length === 2 && !dirsAfter.some(x => dirsBefore.includes(x)) && left.nbKeys === 2, 'c) keine Seiten-Dateien und NotebookKeys des alten Schlüssels mehr', `ordner=${dirsAfter.length} alt=${dirsBefore.length} nbKeys=${left.nbKeys}`);
  await reload(e);
  snapE = await snapshot(e, ['Alpha', 'Beta']);
  ok(snapE === snapA2 && JSON.stringify((await names(e)).slice().sort()) === '["Alpha","Beta"]', 'c) Reload ok, unverändert', snapE);

  // ══ Altformat v2 (MasterKey-verschlüsselt, materialisierte Striche) ══════
  const F = await mk('F', { blockRelay: true }); const f = F.page; await fresh(F);
  await draw(f); await sleep(2000);
  const nameF = (await names(f))[0];
  // Die frühere Funktion buildEncryptedBackupBundle() nachgebaut: eigene Seite (vorhandener Strich + 2 weitere)
  // und ein zweites Notizbuch „Altbestand“ mit 2 Strichen.
  const v2 = await f.evaluate(async (nbName) => {
    const enc = await import('/js/encryption.js');
    const root = await navigator.storage.getDirectory(); const nbDir = await root.getDirectoryHandle('notebooks');
    let nbId = null, pageId = null, data = null;
    for await (const [n, h] of nbDir.entries()) { nbId = n; const pages = await h.getDirectoryHandle('pages'); for await (const [pn, fh] of pages.entries()) { pageId = pn.replace(/\.bin$/, ''); data = new Uint8Array(await (await fh.getFile()).arrayBuffer()); } }
    const nbKeyRaw = JSON.parse(localStorage.getItem('notizbuch:nbKey:' + nbId));
    const page = JSON.parse(new TextDecoder().decode(await enc.decrypt(await enc.importKey(new Uint8Array(nbKeyRaw), true), data)));
    const own = page.events.filter(ev => ev.type === 'stroke').map(ev => ev.stroke);
    const mkStroke = (id, yy) => ({ id, createdAt: Date.now(), points: [{ x: 100, y: yy }, { x: 220, y: yy + 5 }, { x: 340, y: yy }], color: '#1a1a1a', size: 3, tool: 'pen' });
    const meta = (id, strokes) => ({ id, background: 'grid', order: 0, createdAt: 1, clearedAt: 0, deletedAt: 0, restoredAt: 0, strokes });
    const oldKey = Array.from(await enc.exportKey(await enc.generateKey(true)));
    const payload = { type: 'notizbuch-backup-v2', exportedAt: new Date().toISOString(), masterKeyHash: localStorage.getItem('notizbuch:masterKeyHash'),
      notebookKeys: { [nbId]: nbKeyRaw, 'v2-altbestand': oldKey },
      notebooks: [{ id: nbId, name: nbName, pages: [meta(pageId, [...own, mkStroke('v2-a', 400), mkStroke('v2-b', 450)])] }, { id: 'v2-altbestand', name: 'Altbestand', pages: [meta('v2-p1', [mkStroke('v2-c', 200), mkStroke('v2-d', 260)])] }] };
    const master = await enc.importKey(new Uint8Array(JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw'))), true);
    return { bytes: Array.from(await enc.encrypt(master, new TextEncoder().encode(JSON.stringify(payload)))), own: own.length };
  }, nameF);
  fs.writeFileSync(FILE_V2, Buffer.from(v2.bytes));
  ok(v2.own === 1 && await cnt(f) === 1, 'v2: Ausgangslage — 1 eigener Strich, v2-Datei erzeugt', `eigene=${v2.own}`);
  for (const round of [1, 2]) {
    await dataTab(f); await f.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
    await startImport(f, FILE_V2);
    const got = await waitToast(f, /^Sicherung eingespielt: 2 Notizbücher, 2 Seiten$/, 15000);
    ok(got && await hidden(f, 'prompt-modal') && await hidden(f, 'confirm-modal'), `v2 (${round}. Einspielen): öffnet sich mit dem Geräteschlüssel, ohne Passphrase-Abfrage`, JSON.stringify(await toasts(f)));
    await closeAll(f); await sleep(800);
    const sf = await snapshot(f, [nameF, 'Altbestand']);
    ok(sf === JSON.stringify({ [nameF]: { pages: ['3/3/grid'], geloescht: 0, btn: '' }, Altbestand: { pages: ['2/2/grid'], geloescht: 0, btn: '' } }), `v2 (${round}. Einspielen): Striche da (eigene Seite 3, Altbestand 2), nichts doppelt`, sf);
  }
  const ids = await f.evaluate(async () => {
    const enc = await import('/js/encryption.js'); const root = await navigator.storage.getDirectory();
    const fh = await (await (await (await root.getDirectoryHandle('notebooks')).getDirectoryHandle('v2-altbestand')).getDirectoryHandle('pages')).getFileHandle('v2-p1.bin');
    const key = await enc.importKey(new Uint8Array(JSON.parse(localStorage.getItem('notizbuch:nbKey:v2-altbestand'))), true);
    return JSON.parse(new TextDecoder().decode(await enc.decrypt(key, new Uint8Array(await (await fh.getFile()).arrayBuffer())))).events.map(ev => ev.id).sort().join(',');
  }).catch(err => 'FEHLER ' + err.message);
  ok(ids === 'import:v2-c,import:v2-d', 'v2: Striche liegen als stroke-Events mit stabilen IDs (import:{strokeId}) auf der Platte', ids);
  await reload(f);
  ok(await snapshot(f, [nameF, 'Altbestand']) === JSON.stringify({ [nameF]: { pages: ['3/3/grid'], geloescht: 0, btn: '' }, Altbestand: { pages: ['2/2/grid'], geloescht: 0, btn: '' } }), 'v2: nach Reload unverändert');
  // v2-Datei eines fremden Schlüssels: Passphrase-Abfrage, lässt sich nicht öffnen, nichts verändert
  await dataTab(d); await startImport(d, FILE_V2);
  ok(await promptOpen(d), 'v2-Datei eines fremden Schlüssels: Passphrase-Abfrage statt stillem Fehler');
  await enterPass(d, PASS); await sleep(2500);
  ok(!(await hidden(d, 'prompt-modal')) && /keine passende Sicherung/.test(await promptError(d)) && (await names(d)).length === 3, 'fremde Datei: Meldung am Feld, nichts verändert', await promptError(d));
  await closeAll(d);
  // Beschädigte Datei
  const broken = Buffer.from(bytes1); broken[broken.length - 5] ^= 0xff;
  await dataTab(d); await startImport(d, { name: 'kaputt.enc', mimeType: 'application/octet-stream', buffer: broken }); await promptOpen(d); await enterPass(d, PASS); await sleep(2500);
  ok(!(await hidden(d, 'prompt-modal')) && (await promptError(d)).length > 10 && (await names(d)).length === 3, 'beschädigte Datei (richtige Passphrase): Meldung am Feld, nichts verändert', await promptError(d));
  await closeAll(d);

  // ══ Altes Schlüsselbündel (nur Schlüssel, Passphrase) ════════════════════
  const G = await mk('G', { blockRelay: true }); const g = G.page;
  await g.goto(URL); await g.waitForSelector('#firststart-modal:not(.hidden)');
  // Früheres exportAppBundle() nachgebaut: { masterKey, notebookKeys, exportedAt } ohne Typ
  const bundle = await g.evaluate(async ([hex, pass]) => {
    const enc = await import('/js/encryption.js');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await enc.deriveKeyFromPassphrase(pass, salt);
    const payload = { masterKey: hex.match(/../g).map(h => parseInt(h, 16)), notebookKeys: {}, exportedAt: new Date().toISOString() };
    const e2 = await enc.encrypt(key, new TextEncoder().encode(JSON.stringify(payload)));
    return [...salt, ...e2];
  }, [hexA, PASS]);
  await startImport(g, { name: 'schluessel.enc', mimeType: 'application/octet-stream', buffer: Buffer.from(bundle) }, '#btn-restore-backup');
  await promptOpen(g); await enterPass(g, PASS);
  await g.waitForFunction(h => localStorage.getItem('notizbuch:masterKeyHash') === h, hashA, { timeout: 20000 }).catch(() => {});
  await ready(g).catch(() => {});
  const toastG = await waitToast(g, /Schlüssel aus der Sicherung übernommen/, 8000);
  ok(await keyHash(g) === hashA && toastG, 'altes Schlüsselbündel (nur Schlüssel) bleibt importierbar: Schlüssel von A installiert, Hinweis nach dem Neuladen');

  // ══ Querschnitt ══════════════════════════════════════════════════════════
  const dialogs = all.flatMap(X => X.dialogs.map(t => `${X.name} ${t}`));
  ok(dialogs.length === 0, 'kein nativer Dialog', JSON.stringify(dialogs));
  const errs = all.flatMap(X => X.logs.filter(l => /^error|PAGEERROR/.test(l)).map(l => `${X.name} ${l}`));
  ok(errs.length === 0, 'keine Konsolenfehler', errs.slice(0, 6).join(' || '));
  const leaked = all.flatMap(X => X.logs.filter(l => l.includes(PASS) || l.includes(WRONG) || l.includes(hexA)).map(() => X.name));
  ok(leaked.length === 0, 'Passphrase und Schlüssel stehen in keiner Konsolenzeile', leaked.join(','));

  console.log(fails ? `ERGEBNIS: ${fails} FEHLER` : 'ERGEBNIS: ALLES OK');
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TESTFEHLER', e); process.exit(2); });
