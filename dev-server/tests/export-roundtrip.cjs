// Prüfung Export/Import-Rundlauf (NUR Befund, kein „muss grün sein“-Test): node export-roundtrip.cjs <URL>
// Kontext 1 zeichnet und exportiert über Einstellungen → Daten & Schlüssel (Download wird abgefangen).
// Ein frischer Kontext 2 importiert genau diese Datei. Ausgegeben wird, was dabei passiert.
// Endet immer mit Exit-Code 0, außer der Ablauf selbst lässt sich nicht durchführen (2).
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('fs');
const URL = process.argv[2] || 'https://localhost:4444/app.html';
const FILE = process.env.OUT_FILE || '/tmp/notes-ui/notizbuch-backup.enc';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = (k, v) => console.log(`BEFUND ${k}: ${v}`);

(async () => {
  fs.mkdirSync(require('path').dirname(FILE), { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--ignore-certificate-errors'] });
  const mk = async name => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, ignoreHTTPSErrors: true, acceptDownloads: true });
    await ctx.addInitScript(() => localStorage.setItem('notizbuch:debugOverlay', '1'));
    await ctx.addInitScript(() => { RTCPeerConnection.prototype.setRemoteDescription = () => Promise.reject(new Error('WebRTC blockiert (Test)')); });
    const page = await ctx.newPage(); const logs = [], dialogs = [];
    page.on('console', m => logs.push(`${m.type()}: ${m.text().slice(0, 200)}`));
    page.on('pageerror', e => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
    page.on('dialog', d => { dialogs.push(`${d.type()}: ${d.message().slice(0, 120)}`); d.dismiss().catch(() => {}); });
    return { name, page, logs, dialogs };
  };
  const ready = p => p.waitForFunction(() => /device: [0-9a-f]/.test(document.getElementById('console')?.innerText || ''), null, { timeout: 20000 });
  const fresh = async X => { await X.page.goto(URL); await X.page.click('#btn-new-start'); await X.page.click('#btn-key-confirmed'); await ready(X.page); await sleep(2500); };
  const cnt = p => p.evaluate(() => { const m = (document.getElementById('console')?.innerText || '').match(/striche: (\d+)/); return m ? Number(m[1]) : -1; });
  const keyHash = p => p.evaluate(() => localStorage.getItem('notizbuch:masterKeyHash'));
  const dataTab = async p => { await p.click('#btn-notebooks'); await sleep(300); await p.click('#btn-settings'); await sleep(300); await p.click('#set-tab-data'); await sleep(300); };
  const toasts = p => p.evaluate(() => [...document.querySelectorAll('#toasts .toast span')].map(e => e.textContent));

  // ── Kontext 1: zeichnen, exportieren ───────────────────────────────────
  const A = await mk('A'); await fresh(A);
  const box = await A.page.evaluate(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); return { x: c.x, y: c.y }; });
  for (const y of [220, 300]) { await A.page.mouse.move(box.x + 150, box.y + y); await A.page.mouse.down(); for (let i = 0; i <= 20; i++) await A.page.mouse.move(box.x + 150 + i * 15, box.y + y); await A.page.mouse.up(); }
  await sleep(2000);
  say('Kontext 1 Striche vor Export', await cnt(A.page));
  await dataTab(A.page);
  const [download] = await Promise.all([A.page.waitForEvent('download', { timeout: 15000 }), A.page.click('#btn-export-enc')]);
  await download.saveAs(FILE);
  const bytes = fs.readFileSync(FILE);
  say('Exportdatei', `${download.suggestedFilename()} — ${bytes.length} Bytes → ${FILE}`);
  say('Hinweis nach Export', JSON.stringify(await toasts(A.page)));

  // Was steht drin? Mit dem MasterKey von Kontext 1 entschlüsseln (so wie buildEncryptedBackupBundle verschlüsselt).
  const inside = await A.page.evaluate(async arr => {
    const enc = await import('/js/encryption.js');
    const raw = new Uint8Array(JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw')));
    const out = {};
    try {
      const key = await enc.importKey(raw, true);
      const obj = JSON.parse(new TextDecoder().decode(await enc.decrypt(key, new Uint8Array(arr))));
      out.masterKeyDecrypt = 'ok';
      out.felder = Object.keys(obj);
      out.type = obj.type;
      out.enthaeltMasterKey = 'masterKey' in obj;
      out.notebooks = (obj.notebooks || []).map(n => ({ name: n.name, seiten: n.pages.length, striche: n.pages.reduce((s, p) => s + (p.strokes || []).length, 0) }));
      out.notebookKeys = Object.keys(obj.notebookKeys || {}).length;
    } catch (e) { out.masterKeyDecrypt = 'FEHLER ' + (e.message || e.name); }
    return out;
  }, [...bytes]);
  say('Inhalt (mit MasterKey von Kontext 1 entschlüsselt)', JSON.stringify(inside));
  const hashA = await keyHash(A.page);

  // ── Kontext 2: frisch, dieselbe Datei importieren ──────────────────────
  const B = await mk('B'); await fresh(B);
  const hashB0 = await keyHash(B.page);
  await dataTab(B.page);
  const [chooser] = await Promise.all([B.page.waitForEvent('filechooser', { timeout: 10000 }), B.page.click('#btn-import')]);
  await chooser.setFiles(FILE);
  const asked = await B.page.waitForSelector('#prompt-modal:not(.hidden)', { timeout: 5000 }).then(() => true).catch(() => false);
  say('Import fragt nach', asked ? `„${await B.page.evaluate(() => document.getElementById('prompt-label').textContent)}“ (Dialog „${await B.page.evaluate(() => document.getElementById('prompt-title').textContent)}“) — beim Export wurde aber nie eine Passphrase vergeben` : 'nichts (kein Eingabe-Dialog)');
  const tried = [];
  if (asked) {
    const keyHexA = await A.page.evaluate(() => JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw')).map(x => x.toString(16).padStart(2, '0')).join(''));
    for (const [what, pw] of [['beliebige Passphrase', 'test1234'], ['MasterKey (Hex) von Kontext 1 als Passphrase', keyHexA]]) {
      await B.page.fill('#prompt-input', pw); await B.page.keyboard.press('Enter'); await sleep(2500);
      const open = await B.page.evaluate(() => !document.getElementById('prompt-modal').classList.contains('hidden')).catch(() => false);
      const err = open ? await B.page.evaluate(() => document.getElementById('prompt-error').textContent) : '';
      tried.push(`${what} → ${open ? 'abgelehnt: „' + err + '“' : 'angenommen'}`);
      if (!open) break;
    }
    tried.forEach(t => say('Import-Versuch', t));
    await B.page.keyboard.press('Escape').catch(() => {});
  }
  // Direkt die Import-Funktion befragen, um die rohe Fehlermeldung zu sehen
  const rawErr = await B.page.evaluate(async arr => {
    const share = await import('/js/share.js');
    try { await share.importAppBundle(new Uint8Array(arr), 'test1234'); return 'kein Fehler'; } catch (e) { return `${e.name}: ${e.message || '(ohne Text)'}`; }
  }, [...bytes]).catch(e => 'Seite neu geladen? ' + e.message);
  say('importAppBundle(Exportdatei, Passphrase) wirft', rawErr);
  await sleep(1500);
  const hashB1 = await keyHash(B.page).catch(() => null);
  say('Schlüssel in Kontext 2', hashB1 === hashA ? 'ist jetzt der von Kontext 1 (Import hat gegriffen)' : hashB1 === hashB0 ? 'unverändert (Import hat nichts übernommen)' : `anders: ${hashB1}`);
  say('Striche in Kontext 2 nach Import', await cnt(B.page).catch(() => -1));
  say('native Dialoge', JSON.stringify(A.dialogs.concat(B.dialogs)));
  say('Hinweise in Kontext 2', JSON.stringify(await toasts(B.page).catch(() => [])));

  // Wird das Gegenstück zum Import (exportAppBundle) überhaupt aufgerufen?
  const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'js', 'app.js'), 'utf8');
  const calls = name => src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => new RegExp(`\\b${name}\\(`).test(l) && !/^\s*(\/\/|\*|import|async function|function)/.test(l)).map(([n]) => n);
  say('Aufrufe exportAppBundle( in js/app.js', JSON.stringify(calls('exportAppBundle')) + ' (nur importiert, nie aufgerufen, wenn leer)');
  say('Aufrufe buildEncryptedBackupBundle( in js/app.js', JSON.stringify(calls('buildEncryptedBackupBundle')));
  say('Aufrufe importAppBundle( in js/app.js', JSON.stringify(calls('importAppBundle')));

  const roundtrip = hashB1 === hashA && (await cnt(B.page).catch(() => -1)) === 2;
  console.log(`ERGEBNIS RUNDLAUF: ${roundtrip ? 'funktioniert (Kontext 2 zeigt die 2 Striche)' : 'FUNKTIONIERT NICHT — die eigene Exportdatei lässt sich nicht importieren'}`);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('TESTFEHLER', e); process.exit(2); });
