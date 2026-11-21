// UI-Test Redesign Teil B: node ui-b.cjs <URL>
// Notizbuch-Schublade, „⋯“-Menü, Einstellungen (Theme, Nur Stift, Diagnose, Relay-Adresse),
// Teilen-Dialog (Einladen/Beitreten), Erststart. Schreibt Screenshots nach /tmp/notes-ui/.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('fs');
const URL = process.argv[2] || 'https://localhost:4444/app.html';
const OUT = process.env.OUT || '/tmp/notes-ui';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (cond, label, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${extra !== '' ? ' — ' + extra : ''}`); };
const XSS = '<img src=x onerror=alert(1)>';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--ignore-certificate-errors'] });
  const dialogs = [];
  const mk = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true, colorScheme: 'light', acceptDownloads: true });
    if (process.env.NO_P2P) await ctx.addInitScript(() => { RTCPeerConnection.prototype.setRemoteDescription = () => Promise.reject(new Error('WebRTC blockiert (Test)')); });
    const page = await ctx.newPage(); const logs = [];
    page.on('console', m => { const t = m.text(); if (!/WebSocket connection|willReadFrequently|Password field/.test(t)) logs.push(`${m.type()}: ${t.slice(0, 220)}`); });
    page.on('pageerror', e => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
    page.on('dialog', d => { dialogs.push(`${d.type()}: ${d.message().slice(0, 80)}`); d.dismiss().catch(() => {}); });
    return { ctx, page, logs };
  };
  const A = await mk();
  const { page, logs } = A;
  const shot = name => page.screenshot({ path: `${OUT}/${name}` });
  const ready = (p = page) => p.waitForFunction(() => (document.getElementById('notebook-title')?.textContent || '').length > 0 && document.getElementById('active-canvas')?.width > 0, null, { timeout: 20000 });
  const $ = (fn, arg) => page.evaluate(fn, arg);
  const visible = sel => $(s => { const e = document.querySelector(s); return !!e && !e.hidden && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; }, sel);
  const text = sel => $(s => document.querySelector(s)?.textContent.trim(), sel);
  const active = () => $(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName);
  const drawerOpen = () => $(() => document.querySelector('.sidebar').classList.contains('sidebar-open'));
  const names = () => $(() => [...document.querySelectorAll('#notebook-list > * .nb-name')].map(e => e.textContent));
  const idb = key => $(k => new Promise(res => { const r = indexedDB.open('notizbuch-settings', 1); r.onsuccess = () => { r.result.transaction('settings').objectStore('settings').get(k).onsuccess = e => res(e.target.result ?? null); }; }), key);
  // Kein horizontaler Scroll: weder Seite noch offene Fläche, und nichts Sichtbares ragt aus dem Bild
  const noHScroll = async (label, rootSel) => {
    const r = await $(sel => { const root = document.querySelector(sel); const out = [...root.querySelectorAll('*')].filter(e => { if (!e.getClientRects().length || e.closest('[hidden]')) return false; const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 0.5 || b.left < -0.5); }).map(e => e.id || e.tagName + '.' + e.className); return { sw: document.documentElement.scrollWidth, iw: innerWidth, rsw: root.scrollWidth, rcw: root.clientWidth, out }; }, rootSel);
    ok(r.sw <= r.iw && r.rsw <= r.rcw && r.out.length === 0, `${label}: kein horizontaler Scroll`, `seite ${r.sw}/${r.iw} fläche ${r.rsw}/${r.rcw}${r.out.length ? ' außerhalb: ' + r.out.slice(0, 4).join(',') : ''}`);
  };
  const openNbMenu = async name => { await $(n => { const row = [...document.querySelectorAll('#notebook-list > *')].find(r => r.querySelector('.nb-name').textContent === n); row.querySelector('.nb-more').scrollIntoView({ block: 'nearest' }); row.dataset.t = '1'; }, name); await page.click('#notebook-list > [data-t="1"] .nb-more'); await $(() => document.querySelectorAll('[data-t]').forEach(e => delete e.dataset.t)); await sleep(150); };
  const rename = async (from, to) => { await openNbMenu(from); await page.click('#nb-menu-rename'); await page.fill('.rename-input', to); await page.keyboard.press('Enter'); await sleep(500); };

  // ── Erststart: Schritt 1 → Schritt 2 ───────────────────────────────────
  await page.goto(URL);
  await page.waitForSelector('#firststart-modal:not(.hidden)');
  ok(await $(() => document.querySelector('#firststart-modal').contains(document.activeElement)), 'Erststart: Fokus liegt im Dialog', await active());
  ok(/Schritt 1 von 2/.test(await text('#firststart-modal')), 'Erststart zeigt „Schritt 1 von 2“');
  await sleep(400); await shot('erststart.png');
  await page.keyboard.press('Escape'); await sleep(150);
  ok(await visible('#firststart-modal'), 'Erststart lässt sich nicht mit Esc überspringen');
  await page.click('#btn-new-start');
  await page.waitForSelector('#keydisplay-modal:not(.hidden)');
  const keyText = await text('#keydisplay-key');
  ok(/^([0-9a-f]{8} ){7}[0-9a-f]{8}$/.test(keyText) && /Schritt 2 von 2/.test(await text('#keydisplay-modal')), 'Schritt 2 zeigt den Schlüssel in Achtergruppen', keyText.slice(0, 17) + '…');
  ok(await $(() => getComputedStyle(document.querySelector('#keydisplay-modal p')).color !== getComputedStyle(document.documentElement).getPropertyValue('--danger')) && await visible('#btn-download-key') && await visible('#btn-copy-key'), 'Schlüssel-Dialog: Sichern-Knöpfe statt roter Textwand');
  await sleep(400); await shot('schluessel.png');
  await page.click('#btn-key-confirmed'); await ready(); await sleep(1500);
  ok(!(await visible('#keydisplay-modal')) && await $(() => document.querySelectorAll('canvas')[2]?.id === 'active-canvas'), 'nach Bestätigung: App bereit, canvas[2] ist die aktive Zeichenfläche');
  ok(await $(() => [...document.querySelectorAll('.modal-overlay')].every(o => { const d = o.querySelector('[role="dialog"]'); return d && d.getAttribute('aria-modal') === 'true' && document.getElementById(d.getAttribute('aria-labelledby')); })), 'alle Dialoge: role=dialog, aria-modal, aria-labelledby');
  ok(await $(() => !document.querySelector('.modal-overlay [style*="font-size"], .sidebar [style*="font-size"]')) && await $(() => !document.querySelector('.footer-btn, .nb-context-menu, .nb-actions, #connection-modal, #export-modal, #scan-modal, #btn-pen-only')), 'keine Inline-Schriftgrößen, keine alten Einzel-Modals/Footer-Knöpfe im DOM');

  // ── Schublade ──────────────────────────────────────────────────────────
  await page.click('#btn-notebooks'); await sleep(400);
  ok(await drawerOpen() && await $(() => document.querySelector('.sidebar').contains(document.activeElement)), 'Titel öffnet die Schublade, Fokus liegt darin', await active());
  ok(await $(() => { const f = document.querySelector('.drawer-foot'); return f.querySelectorAll('button').length === 2 && !!f.querySelector('#status-row') && !!f.querySelector('#btn-settings') && !!document.getElementById('btn-join-notebook') && document.querySelectorAll('.sidebar button').length === 3 + 2 + 2 * document.querySelectorAll('#notebook-list > *').length; }), 'Schublade enthält nur Notizbücher, „Neues Notizbuch“, „Notizbuch beitreten“, Statuszeile + Zahnrad');
  ok(/\S/.test(await text('#status-text')), 'Statuszeile zeigt Text', await text('#status-text'));
  await page.keyboard.press('Escape'); await sleep(400);
  ok(!(await drawerOpen()) && await active() === 'btn-notebooks', 'Esc schließt die Schublade, Fokus zurück am Titel', await active());
  await page.click('#btn-notebooks'); await sleep(300); await page.click('#btn-close-sidebar'); await sleep(400);
  ok(!(await drawerOpen()), 'Schließen-Knopf schließt die Schublade');
  await page.click('#btn-notebooks'); await sleep(300); await page.mouse.click(900, 500); await sleep(400);
  ok(!(await drawerOpen()), 'Tipp neben die Schublade schließt sie');

  // ── Notizbuch anlegen, umbenennen, wechseln, löschen ───────────────────
  await page.click('#btn-notebooks'); await sleep(300);
  const first = (await names())[0];
  await page.click('#btn-add-notebook'); await sleep(900);
  let nb = await names();
  ok(nb.length === 2 && nb[1] === 'Neues Notizbuch' && await text('#notebook-title') === 'Neues Notizbuch', 'Notizbuch angelegt und geöffnet', nb.join(' | '));
  await page.click('#btn-add-notebook'); await sleep(900);
  await rename('Neues Notizbuch', 'Projektskizzen');
  await shot('schublade-light-1400.png');
  await openNbMenu('Projektskizzen');
  ok(await visible('#nb-menu') && await $(() => ['nb-menu-rename', 'nb-menu-share', 'nb-menu-delete'].every(id => document.getElementById(id).getClientRects().length)) && await $(() => document.getElementById('nb-menu').contains(document.activeElement)), '„⋯“ öffnet das Menü (Umbenennen, Teilen, Löschen), Fokus im Menü');
  ok(await $(() => { const r = document.getElementById('nb-menu').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), 'Menü liegt vollständig im Bild');
  await shot('schublade-menue.png');
  await page.keyboard.press('Escape'); await sleep(200);
  ok(!(await visible('#nb-menu')) && await drawerOpen(), 'Esc schließt erst das Menü, die Schublade bleibt offen');
  nb = await names();
  ok(nb.includes('Projektskizzen') && nb.length === 3, 'per „⋯“ umbenannt (Eingabefeld in der Zeile)', nb.join(' | '));
  await openNbMenu('Projektskizzen'); await page.click('#nb-menu-rename'); await page.fill('.rename-input', 'Verworfen'); await page.keyboard.press('Escape'); await sleep(300);
  ok((await names()).includes('Projektskizzen') && await drawerOpen(), 'Esc beim Umbenennen verwirft, Schublade bleibt offen');
  await rename('Projektskizzen', XSS);
  nb = await names();
  ok(nb.includes(XSS) && await $(() => !document.querySelector('.sidebar img, .tb img')) && dialogs.length === 0, 'Name mit HTML erscheint als Text (kein <img>, kein Dialog)', nb.join(' | ') + (dialogs.length ? ' DIALOG ' + dialogs.join(',') : ''));
  // Zeile selbst per JS anklicken (wie accept.cjs) → wechselt das Notizbuch
  await $(n => [...document.querySelectorAll('#notebook-list > *')].find(r => r.querySelector('.nb-name').textContent === n).click(), XSS); await sleep(900);
  ok(await text('#notebook-title') === XSS && !(await drawerOpen()) && await $(() => !document.querySelector('.tb img')), 'Klick auf die Zeile wechselt das Notizbuch; Titel zeigt den Namen als Text', await text('#notebook-title'));
  await page.click('#btn-notebooks'); await sleep(300);
  await openNbMenu(XSS); await page.click('#nb-menu-delete'); await sleep(300);
  ok(await visible('#confirm-modal') && (await text('#confirm-title')).includes(XSS) && await $(() => !document.querySelector('#confirm-modal img')) && await active() === 'confirm-cancel', 'Löschen fragt nach (Dialog, Name als Text, Fokus auf „Abbrechen“)', await text('#confirm-title'));
  await page.click('#confirm-cancel'); await sleep(300);
  ok((await names()).length === 3 && !(await visible('#confirm-modal')), 'Abbrechen löscht nichts');
  await openNbMenu(XSS); await page.click('#nb-menu-delete'); await sleep(300); await page.keyboard.press('Escape'); await sleep(300);
  ok((await names()).length === 3 && !(await visible('#confirm-modal')), 'Esc in der Rückfrage löscht nichts');
  await openNbMenu(XSS); await page.click('#nb-menu-delete'); await sleep(300); await page.click('#confirm-ok'); await sleep(1200);
  nb = await names();
  ok(nb.length === 2 && !nb.includes(XSS), 'Löschen entfernt das Notizbuch', nb.join(' | '));
  ok(dialogs.length === 0, 'bis hier kein confirm()/alert()/prompt()', dialogs.join(' | '));

  // ── Einstellungen: Allgemein ───────────────────────────────────────────
  await page.click('#btn-settings'); await sleep(400);
  ok(await visible('#settings-modal') && await visible('#set-panel-general') && !(await drawerOpen()) && await $(() => document.getElementById('settings-modal').contains(document.activeElement)), 'Zahnrad öffnet die Einstellungen (Allgemein), Fokus im Dialog');
  ok(await $(() => [...document.querySelectorAll('#settings-sheet [role="tab"]')].map(t => t.textContent.trim()).join('|')) === 'Allgemein|Geräte|Verbindung|Daten & Schlüssel', 'vier Abschnitte: Allgemein, Geräte, Verbindung, Daten & Schlüssel');
  ok(await $(() => !/Finger bewegen|Aufbewahrung|Gerätename/i.test(document.getElementById('settings-modal').textContent)), 'nicht Entschiedenes fehlt (Finger bewegen, Gerätenamen, Aufbewahrungsfrist)');
  await shot('einstellungen-light-1400.png');
  await page.click('#theme-seg [data-choice="dark"]'); await sleep(300);
  ok(await $(() => document.documentElement.dataset.theme) === 'dark' && await $(() => document.querySelector('#theme-seg [data-choice="dark"]').getAttribute('aria-pressed')) === 'true' && await $(() => getComputedStyle(document.querySelector('#settings-modal .dialog')).backgroundColor) === 'rgb(27, 30, 36)', 'Erscheinungsbild „Dunkel“ wirkt sofort');
  await shot('einstellungen-dark-1400.png');
  await page.click('#set-pen-only'); await sleep(400);
  ok(await $(() => document.getElementById('set-pen-only').checked), 'Schalter „Nur der Stift zeichnet“ an');
  await page.keyboard.press('Escape'); await sleep(300);
  ok(!(await visible('#settings-modal')), 'Esc schließt die Einstellungen');
  // Nur Stift: Finger (Touch) zeichnet nicht mehr
  const hash = await $(() => localStorage.getItem('notizbuch:masterKeyHash'));
  ok(await idb(hash + ':penOnlyMode') === true, '„Nur Stift“ ist gespeichert (bestehender Stiftmodus)');
  await page.reload(); await ready(); await sleep(1500);
  ok(await $(() => document.documentElement.dataset.theme) === 'dark', 'Theme bleibt nach Reload dunkel');
  await page.click('#btn-notebooks'); await sleep(300); await page.click('#btn-settings'); await sleep(300);
  ok(await $(() => document.querySelector('#theme-seg [data-choice="dark"]').getAttribute('aria-pressed') === 'true' && document.getElementById('set-pen-only').checked), 'nach Reload: „Dunkel“ gewählt, „Nur Stift“ an');
  await page.click('#set-pen-only'); await page.click('#theme-seg [data-choice="light"]'); await sleep(300);
  ok(await $(() => document.documentElement.dataset.theme) === 'light', 'Erscheinungsbild „Hell“ wirkt');
  await page.click('#theme-seg [data-choice="system"]'); await sleep(300);
  ok(await $(() => document.documentElement.dataset.theme) === 'light' && await $(() => window.getTheme()) === 'system', '„System“ folgt dem System (hell)');

  // ── Einstellungen: Geräte ──────────────────────────────────────────────
  await page.click('#set-tab-devices'); await sleep(200);
  ok(await visible('#set-panel-devices') && !(await visible('#pair-box')) && await $(() => !document.querySelector('#sync-qr canvas, #sync-qr img') && document.getElementById('sync-link-text').textContent === ''), 'Geräte: Sync-Code ist zunächst verborgen (nicht im DOM)');
  ok(/Gerät/.test(await text('#set-device-status')), 'Geräte: Anzahl verbundener Geräte als Text', await text('#set-device-status'));
  await page.click('#btn-pair-toggle'); await sleep(300);
  const keyHexA = await $(() => JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw')).map(b => b.toString(16).padStart(2, '0')).join(''));
  ok(await visible('#pair-box') && (await text('#sync-link-text')).endsWith('#' + keyHexA) && await $(() => !!document.querySelector('#sync-qr canvas, #sync-qr img')) && /enthält deinen Schlüssel/.test(await text('#pair-box')), '„Gerät hinzufügen“ zeigt Warnung, QR und Sync-Link mit dem Schlüssel');
  ok(await $(() => document.querySelectorAll('canvas')[2]?.id === 'active-canvas'), 'QR-Canvas liegt hinter der Zeichenfläche (canvas[2] bleibt aktiv)');
  ok(await visible('#btn-device-scan'), '„Code eines Geräts scannen“ vorhanden');

  // ── Einstellungen: Verbindung (Diagnose, Relay) ────────────────────────
  await page.click('#set-tab-connection'); await sleep(200);
  ok(await visible('#set-panel-connection') && await $(() => document.getElementById('sync-link-text').textContent === ''), 'Verbindung offen; Sync-Code beim Verlassen von „Geräte“ wieder entfernt');
  ok(await $(() => ['conn-turn-url', 'conn-turn-user', 'conn-turn-pass', 'conn-relay-url', 'set-diag', 'btn-save-connection', 'btn-relay-default'].every(id => document.getElementById(id)?.getClientRects().length)), 'TURN-Felder, Relay-Feld, Diagnose-Schalter, Speichern, Standard wiederherstellen');
  await page.click('#set-diag'); await sleep(200);
  ok(await $(() => !document.getElementById('console').classList.contains('debug-off')) && /fill-v48/.test(await $(() => document.getElementById('console').innerText)) && await $(() => localStorage.getItem('notizbuch:debugOverlay')) === '1', 'Diagnose-Schalter blendet #console ein (Version v45)');
  await page.click('#set-diag'); await sleep(200);
  ok(await $(() => document.getElementById('console').classList.contains('debug-off')), 'Diagnose-Schalter blendet #console aus');
  const def = await text('#conn-relay-default');
  ok(def === 'wss://localhost:4444' || !/localhost|127\.0\.0\.1/.test(URL), 'ohne Einstellung gilt lokal das Relay des Dev-Servers', def);
  for (const bad of ['https://relay.example.org', 'relay.example.org', 'wss://']) {
    await page.fill('#conn-relay-url', bad); await page.click('#btn-save-connection'); await sleep(300);
    ok(await visible('#conn-relay-error') && await idb('device:relayUrl') === null && await $(() => document.getElementById('conn-relay-url').getAttribute('aria-invalid')) === 'true', `ungültige Relay-Adresse abgelehnt: ${bad}`);
  }
  const custom = 'ws://localhost:4999';
  await page.fill('#conn-relay-url', custom); await page.click('#btn-save-connection');
  await page.waitForFunction(() => /^Gespeichert\./.test(document.getElementById('conn-status').textContent), null, { timeout: 40000 }).catch(() => {});
  ok(await idb('device:relayUrl') === custom && !(await visible('#conn-relay-error')) && /nicht verbunden \(eigene Adresse\)/.test(await text('#conn-status')), 'gültige ws-Adresse gespeichert (IndexedDB device:relayUrl)', await text('#conn-status'));
  ok(await visible('#settings-modal'), 'Speichern der Relay-Adresse lädt nicht neu (Dialog bleibt offen)');
  await page.reload(); await ready(); await sleep(4000);
  await page.click('#sync-status'); await sleep(300);
  ok(await visible('#set-panel-connection') && await $(() => document.getElementById('conn-relay-url').value) === custom, 'nach Reload: Sync-Status öffnet „Verbindung“, Relay-Adresse wird angezeigt');
  const offText = await text('#sync-text');
  ok(offText !== 'Online', 'mit unerreichbarem Relay ist der Status nicht „Online“', offText);
  await page.click('#btn-relay-default');
  await page.waitForFunction(() => document.getElementById('sync-text').textContent === 'Online' || /^Verbunden/.test(document.getElementById('sync-text').textContent), null, { timeout: 40000 }).catch(() => {});
  ok(/^(Online|Verbunden)/.test(await text('#sync-text')) && await idb('device:relayUrl') === null && await $(() => document.getElementById('conn-relay-url').value) === '', '„Standard wiederherstellen“: Eintrag entfernt, Status wieder Online', await text('#sync-text'));
  await page.waitForFunction(() => /^Standard wiederhergestellt/.test(document.getElementById('conn-status').textContent), null, { timeout: 40000 }).catch(() => {});
  ok(/Relay: verbunden/.test(await text('#conn-status')), 'Statuszeile meldet das Relay als verbunden', await text('#conn-status'));
  await page.keyboard.press('Escape'); await sleep(300);
  ok(await active() === 'sync-status', 'nach Esc liegt der Fokus wieder auf dem Sync-Status', await active());
  await page.click('#btn-notebooks'); await sleep(300);
  await page.click('#status-row'); await sleep(300);
  ok(await visible('#set-panel-connection') && !(await drawerOpen()), 'Statuszeile der Schublade öffnet „Verbindung“');

  // ── Einstellungen: Daten & Schlüssel, Export ───────────────────────────
  await page.click('#set-tab-data'); await sleep(200);
  ok(await visible('#btn-export-enc') && await visible('#btn-import') && await visible('#btn-key-download') && await visible('#btn-key-copy') && !(await visible('#key-box')), 'Daten & Schlüssel: Export, Import, Schlüssel sichern/kopieren; Schlüssel verborgen');
  await page.click('#btn-key-show'); await sleep(200);
  ok((await text('#key-box')).replace(/ /g, '') === keyHexA, '„Anzeigen“ zeigt den Schlüssel');
  await page.click('#btn-key-show'); await sleep(200);
  ok(!(await visible('#key-box')) && await text('#key-box') === '', '„Verbergen“ entfernt ihn wieder');
  await page.click('#btn-export-enc'); await sleep(300);
  ok(await visible('#backup-export-modal') && await active() === 'export-pass', 'Export fragt die Passphrase in einem eigenen Dialog ab (Fokus im Feld)');
  await page.fill('#export-pass', 'ui-b-Testpassphrase'); await page.fill('#export-pass2', 'ui-b-Testpassphrase');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), page.click('#export-ok')]);
  await sleep(300);
  ok(!!dl && dl.suggestedFilename() === 'notizbuch-backup.enc', 'Export liefert die .enc-Datei', dl?.suggestedFilename());
  ok(/fill-v48/.test(await text('#settings-version')), 'Version steht in den Einstellungen');
  await page.keyboard.press('ArrowUp'); await page.click('#set-tab-data'); await page.keyboard.press('ArrowUp'); await sleep(200);
  ok(await visible('#set-panel-connection') && await active() === 'set-tab-connection', 'Pfeiltasten wechseln die Abschnitte');
  await page.keyboard.press('Escape'); await sleep(300);

  // ── Teilen: Einladen ───────────────────────────────────────────────────
  await page.click('#btn-page-menu'); await page.click('#btn-share'); await sleep(1500);
  const link = await $(() => document.getElementById('share-link').value);
  ok(await visible('#share-modal') && link.includes('#nb-') && link.includes('&k=') && await visible('#share-panel-invite') && await $(() => !!document.querySelector('#qr-container canvas, #qr-container img')) && await $(() => document.getElementById('share-modal').contains(document.activeElement)), 'Seiten-Menü → Teilen/Einladen: Link in #share-link, QR, Fokus im Dialog');
  ok(await $(() => document.getElementById('share-link').tagName === 'INPUT' && document.getElementById('share-link').readOnly) && await text('#share-nb-name') === await text('#notebook-title'), 'Einladen nennt das aktuelle Notizbuch', await text('#share-nb-name'));
  ok(await $(() => document.querySelectorAll('canvas')[2]?.id === 'active-canvas'), 'canvas[2] bleibt die aktive Zeichenfläche (QR liegt dahinter)');
  await shot('teilen-einladen.png');
  await page.keyboard.press('Escape'); await sleep(300);
  ok(!(await visible('#share-modal')) && await active() === 'btn-page-menu', 'Esc schließt Teilen, Fokus zurück am Seiten-Menü', await active());

  // ── Teilen: Beitreten mit Link aus zweitem Browser-Kontext ─────────────
  const B = await mk();
  await B.page.goto(URL); await B.page.click('#btn-new-start'); await B.page.click('#btn-key-confirmed'); await ready(B.page); await sleep(2500);
  await B.page.click('#btn-page-menu'); await B.page.click('#btn-share'); await sleep(1500);
  const invite = (await B.page.evaluate(() => document.getElementById('share-link').value)).replace(/&name=.*$/, '&name=' + encodeURIComponent(XSS));
  await B.page.keyboard.press('Escape'); await sleep(2500);

  await page.click('#btn-page-menu'); await page.click('#btn-share'); await sleep(1200);
  await page.click('#share-tab-join'); await sleep(200);
  ok(await visible('#share-panel-join') && !(await visible('#share-panel-invite')) && await visible('#join-link') && await $(() => document.getElementById('join-link').tagName === 'INPUT') && await visible('#btn-start-scan') && await visible('#btn-scan-image'), 'Beitreten: Kamera, Bild auswählen, Eingabefeld für den Link');
  await page.fill('#join-link', 'kein-link'); await page.click('#btn-join'); await sleep(500);
  ok(await visible('#join-error') && await $(() => document.getElementById('join-link').getAttribute('aria-invalid')) === 'true' && await visible('#share-modal'), 'ungültiger Link: Fehlermeldung am Feld, Dialog bleibt offen', await text('#join-error'));
  await shot('teilen-beitreten.png');
  await page.fill('#join-link', 'https://x.example/app.html#' + keyHexA); await page.click('#btn-join'); await sleep(500);
  ok(await visible('#join-error') && dialogs.length === 0, 'Geräte-Code im Einladungsfeld wird abgelehnt (keine Schlüsselübernahme)', await text('#join-error'));
  const before = (await names()).length;
  await page.fill('#join-link', invite); await page.click('#btn-join');
  await page.waitForFunction(() => document.getElementById('share-modal').classList.contains('hidden'), null, { timeout: 20000 }).catch(() => {});
  await sleep(1000); nb = await names();
  ok(!(await visible('#share-modal')) && nb.length === before + 1 && nb.includes(XSS) && await text('#notebook-title') === XSS, 'eingefügter Einladungslink: Notizbuch erscheint und ist geöffnet', nb.join(' | '));
  ok(await $(() => !document.querySelector('.sidebar img, .tb img')) && dialogs.length === 0, 'Name aus dem Link (name=) landet als Text, kein <img>, kein Dialog', dialogs.join(' | '));
  await page.click('#btn-notebooks'); await sleep(300);
  ok(await $(() => !!document.querySelector('#notebook-list .nb.current .badge')), 'geteiltes Notizbuch trägt die Marke „geteilt“');
  await page.keyboard.press('Escape'); await sleep(300);
  await B.ctx.close();

  // ── Bedienflächen und Schrift in den Dialogen (Knöpfe in einer .seg-Gruppe zählen mit deren Rahmen) ──
  const sizes = async sel => $(s => { const root = document.querySelector(s); const small = [...root.querySelectorAll('button, .input')].filter(e => e.getClientRects().length && !e.closest('[hidden]')).map(e => ({ id: e.id || e.textContent.trim().slice(0, 12), h: Math.round((e.closest('.seg') || e).getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) })).filter(e => e.h < 44 || e.w < 44); const tiny = [...root.querySelectorAll('*')].filter(e => e.getClientRects().length && e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 13).map(e => e.id || e.tagName); return { small, tiny }; }, sel);

  // ── 360 × 740 ──────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 360, height: 740 }); await sleep(500);
  await page.click('#btn-notebooks'); await sleep(400);
  await noHScroll('360: Schublade', '.sidebar');
  let sz = await sizes('.sidebar');
  ok(sz.small.length === 0 && sz.tiny.length === 0, '360: Schublade – Bedienflächen ≥ 44 px, Schrift ≥ 13 px', JSON.stringify(sz));
  await openNbMenu(XSS);
  ok(await $(() => { const r = document.getElementById('nb-menu').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), '360: „⋯“-Menü liegt im Bild');
  await page.keyboard.press('Escape');
  await page.click('#btn-settings'); await sleep(400);
  for (const tab of ['general', 'devices', 'connection', 'data']) {
    await page.click(`#set-tab-${tab}`); await sleep(200);
    if (tab === 'devices') { await page.click('#btn-pair-toggle'); await sleep(300); }
    if (tab === 'data') { await page.click('#btn-key-show'); await sleep(200); }
    await noHScroll(`360: Einstellungen/${tab}`, '#settings-modal .dialog');
    sz = await sizes('#settings-modal .dialog');
    ok(sz.small.length === 0 && sz.tiny.length === 0, `360: Einstellungen/${tab} – Bedienflächen ≥ 44 px, Schrift ≥ 13 px`, JSON.stringify(sz));
    if (tab === 'general') await shot('einstellungen-360.png');
    if (tab === 'connection') await shot('einstellungen-360-verbindung.png');
    if (tab === 'devices') await shot('einstellungen-360-geraete.png');
  }
  ok(await $(() => { const d = document.querySelector('#settings-modal .dialog'); const b = document.getElementById('btn-export-enc'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && d.scrollHeight >= d.clientHeight; }), '360: Inhalt der Einstellungen ist (ggf. per Scrollen) erreichbar');
  await page.keyboard.press('Escape'); await sleep(300);
  await page.click('#btn-page-menu'); await page.click('#btn-share'); await sleep(1200);
  await noHScroll('360: Teilen/Einladen', '#share-modal .dialog');
  sz = await sizes('#share-modal .dialog');
  ok(sz.small.length === 0 && sz.tiny.length === 0, '360: Teilen – Bedienflächen ≥ 44 px, Schrift ≥ 13 px', JSON.stringify(sz));
  await shot('teilen-360.png');
  await page.click('#share-tab-join'); await sleep(200);
  await page.fill('#join-link', 'x'); await page.click('#btn-join'); await sleep(300);
  await noHScroll('360: Teilen/Beitreten', '#share-modal .dialog');
  await shot('teilen-360-beitreten.png');
  // Test-Konvention aus accept.cjs: Dialog per classList schließen, danach wieder normal öffnen
  await $(() => document.getElementById('share-modal').classList.add('hidden')); await sleep(200);
  await page.click('#btn-page-menu'); await page.click('#btn-share'); await sleep(1200);
  ok(await visible('#share-panel-invite') && !(await visible('#join-error')), 'nach .hidden von außen: Teilen öffnet wieder sauber auf „Einladen“');
  await page.keyboard.press('Escape'); await sleep(200);
  await page.setViewportSize({ width: 1400, height: 900 }); await sleep(300);

  // ── Konsole ────────────────────────────────────────────────────────────
  ok(dialogs.length === 0, 'kein confirm()/alert()/prompt() im gesamten Ablauf', dialogs.join(' | '));
  const bad = logs.concat(B.logs).filter(l => /PAGEERROR|^error|ReferenceError|TypeError|fehlgeschlagen/.test(l) && !/User-Initiated Abort|WebRTC blockiert/.test(l));
  ok(bad.length === 0, 'keine Konsolenfehler', bad.slice(0, 8).join(' | '));
  if (process.env.LOGS) console.log(logs.slice(-60).join('\n'));
  await browser.close();
  console.log(`Screenshots: ${OUT}`);
  console.log(fails ? `ERGEBNIS: ${fails} FEHLER` : 'ERGEBNIS: ALLES OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TESTFEHLER', e); process.exit(2); });
