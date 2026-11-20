// Abnahmetest Redo: node redo.cjs <URL>
// Zwei isolierte Browser-Kontexte (Modus device: B importiert den MasterKey von A).
// Liest die Strichzahl der aktuellen Seite aus der Overlay-Zeile 'striche: N'.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const URL = process.argv[2] || 'https://localhost:4444/app.html';
const MODE = 'device';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ov = p => p.evaluate(() => document.getElementById('console')?.innerText.replace(/\n/g, ' ; '));
let fails = 0;
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--ignore-certificate-errors'] });
  const mk = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, ignoreHTTPSErrors: true });
    await ctx.addInitScript(() => localStorage.setItem('notizbuch:debugOverlay', '1'));
    if (process.env.NO_P2P) await ctx.addInitScript(() => { RTCPeerConnection.prototype.setRemoteDescription = () => Promise.reject(new Error('WebRTC blockiert (Test)')); });
    const page = await ctx.newPage(); const logs = [];
    page.on('console', m => { const t = m.text(); if (!/WebSocket connection|willReadFrequently|Password field/.test(t)) logs.push(`${m.type()}: ${t.slice(0, 220)}`); });
    page.on('pageerror', e => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
    return { page, logs };
  };
  const ready = p => p.waitForFunction(() => /device: [0-9a-f]/.test(document.getElementById('console')?.innerText || ''), null, { timeout: 20000 });
  const fresh = async X => { await X.page.goto(URL); await X.page.click('#btn-new-start'); await X.page.click('#btn-key-confirmed'); await ready(X.page); };
  const A = await mk(), B = await mk();
  await fresh(A); await sleep(3000);
  const keyHex = await A.page.evaluate(() => JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw')).map(b => b.toString(16).padStart(2, '0')).join(''));
  await B.page.goto(URL + '#' + keyHex); await ready(B.page).catch(() => {});
  let t0 = Date.now(), joined = false;
  while (!process.env.NO_P2P && Date.now() - t0 < 60000) { const [a, b] = [await ov(A.page), await ov(B.page)]; if (/↳[^;]*connected/.test(a) && /↳[^;]*connected/.test(b)) { joined = true; break; } await sleep(1000); }
  if (process.env.NO_P2P) { await sleep(8000); const [a, b] = [await ov(A.page), await ov(B.page)]; const p2p = /↳[^;]*connected/.test(a) || /↳[^;]*connected/.test(b); console.log(`[${MODE}] OHNE P2P (nur Relay) — P2P wirklich aus:`, !p2p); if (p2p) fails++; }
  else console.log(`[${MODE}] P2P verbunden:`, joined);
  const cnt = p => p.evaluate(() => { const m = (document.getElementById('console')?.innerText || '').match(/striche: (\d+)/); return m ? Number(m[1]) : -1; });
  let y = 120;
  const draw = async p => { y += 60; const box = await p.evaluate(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); return { x: c.x, y: c.y }; });
    await p.mouse.move(box.x + 150, box.y + y); await p.mouse.down(); for (let i = 0; i <= 20; i++) await p.mouse.move(box.x + 150 + i * 15, box.y + y); await p.mouse.up(); };
  const n = cnt;
  const check = async (label, want) => { const [a, b] = [await n(A.page), await n(B.page)]; const ok = a === want && b === want; if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: A=${a} B=${b} (soll ${want})`); };
  const undo = p => p.click('button[title="Rückgängig"]');
  const redo = p => p.click('#btn-redo', { timeout: 5000 });
  const redoDisabled = p => p.evaluate(() => document.getElementById('btn-redo')?.disabled === true);
  const checkRedoDisabled = async (label, p, want) => { const d = await redoDisabled(p); const ok = d === want; if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: disabled=${d} (soll ${want})`); };

  await checkRedoDisabled('Redo-Button bei A anfangs deaktiviert', A.page, true);
  await draw(A.page); await draw(A.page); await sleep(2500); await check('2 Striche von A, B schaut zu', 2);
  await undo(A.page); await sleep(2500); await check('A macht rückgängig', 1);
  await checkRedoDisabled('Redo-Button bei A nach Undo aktiv', A.page, false);
  await checkRedoDisabled('Redo-Button bei B bleibt deaktiviert (fremdes Undo)', B.page, true);
  await redo(A.page); await sleep(2500); await check('A wiederholt', 2);
  await checkRedoDisabled('Redo-Button bei A nach Redo deaktiviert', A.page, true);
  await undo(A.page); await sleep(600); await undo(A.page); await sleep(2500); await check('A macht zweimal rückgängig', 0);
  await redo(A.page); await sleep(600); await redo(A.page); await sleep(2500); await check('A wiederholt zweimal', 2);
  await sleep(9000); await check('2 Striche nach 9s (Relay-Zyklen)', 2);
  await B.page.reload(); await ready(B.page).catch(() => {}); await sleep(8000); await check('nach Reload von B', 2);
  await A.page.reload(); await ready(A.page).catch(() => {}); await sleep(8000); await check('nach Reload von A', 2);
  await undo(A.page); await sleep(2500); await check('A macht nach Reload rückgängig', 1);
  await draw(A.page); await sleep(2500); await check('A zeichnet nach Undo', 2);
  await checkRedoDisabled('Redo-Button bei A nach eigenem Strich deaktiviert', A.page, true);
  await undo(B.page); await sleep(2500); await check('B macht einen Strich rückgängig', 1);
  await checkRedoDisabled('Redo-Button bei A nach fremdem Undo weiterhin deaktiviert', A.page, true);
  for (const [nm, X] of [['A', A], ['B', B]]) { const bad = X.logs.filter(l => /PAGEERROR|^error|ReferenceError|TypeError|fehlgeschlagen/.test(l) && !/User-Initiated Abort|WebRTC blockiert/.test(l)); if (bad.length) { fails++; console.log(`FAIL Fehler in Konsole ${nm}:\n  ` + bad.slice(0, 8).join('\n  ')); } }
  if (process.env.LOGS) { console.log('--- A\n' + A.logs.slice(-30).join('\n')); console.log('--- B\n' + B.logs.slice(-30).join('\n')); }
  await browser.close();
  console.log(fails ? `ERGEBNIS: ${fails} FEHLER` : 'ERGEBNIS: ALLES OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TESTFEHLER', e); process.exit(2); });
