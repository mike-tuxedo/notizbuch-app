// Abnahmetest Sync: node accept.cjs <URL> [device|shared]
// Zwei isolierte Browser-Kontexte. Liest die Strichzahl der aktuellen Seite aus der Overlay-Zeile 'striche: N'.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const URL = process.argv[2] || 'https://localhost:4444/app.html';
const MODE = process.argv[3] || 'device';
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
  if (MODE === 'device') {
    const keyHex = await A.page.evaluate(() => JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw')).map(b => b.toString(16).padStart(2, '0')).join(''));
    await B.page.goto(URL + '#' + keyHex); await ready(B.page).catch(() => {});
  } else {
    await A.page.click('#btn-page-menu'); await A.page.click('#btn-share'); await sleep(1500);
    const link = await A.page.evaluate(() => document.getElementById('share-link').value);
    await A.page.evaluate(() => document.getElementById('share-modal')?.classList.add('hidden'));
    await fresh(B); await sleep(2000);
    await B.page.goto(URL + link.slice(link.indexOf('#'))); await B.page.reload(); await sleep(6000);
    const n = await B.page.evaluate(() => document.querySelectorAll('#notebook-list > *').length);
    for (let i = 0; i < n; i++) { await B.page.evaluate(i => document.querySelectorAll('#notebook-list > *')[i].click(), i); await sleep(1500); if (/shared: [^;]*\*/.test(await ov(B.page))) break; }
  }
  let t0 = Date.now(), joined = false;
  while (!process.env.NO_P2P && Date.now() - t0 < 60000) { const [a, b] = [await ov(A.page), await ov(B.page)]; if (/↳[^;]*connected/.test(a) && /↳[^;]*connected/.test(b)) { joined = true; break; } await sleep(1000); }
  if (process.env.NO_P2P) { await sleep(8000); const [a, b] = [await ov(A.page), await ov(B.page)]; const p2p = /↳[^;]*connected/.test(a) || /↳[^;]*connected/.test(b); console.log(`[${MODE}] OHNE P2P (nur Relay) — P2P wirklich aus:`, !p2p); if (p2p) fails++; }
  else console.log(`[${MODE}] P2P verbunden:`, joined);
  const cnt = p => p.evaluate(() => { const m = (document.getElementById('console')?.innerText || '').match(/striche: (\d+)/); return m ? Number(m[1]) : -1; });
  let y = 120;
  const draw = async p => { y += 60; const box = await p.evaluate(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); return { x: c.x, y: c.y }; });
    await p.mouse.move(box.x + 150, box.y + y); await p.mouse.down(); for (let i = 0; i <= 20; i++) await p.mouse.move(box.x + 150 + i * 15, box.y + y); await p.mouse.up(); };
  await draw(A.page); await sleep(2500);
  const n = cnt;
  const check = async (label, want) => { const [a, b] = [await n(A.page), await n(B.page)]; const ok = a === want && b === want; if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: A=${a} B=${b} (soll ${want})`); };
  await check('1 Strich von A, B schaut zu', 1);
  await draw(A.page); await draw(A.page); await sleep(2500); await check('3 Striche von A, B schaut zu', 3);
  await sleep(9000); await check('3 Striche nach 9s (Relay-Zyklen)', 3);
  await draw(B.page); await sleep(2500); await check('B zeichnet 1 dazu', 4);
  await sleep(9000); await check('4 Striche nach 9s', 4);
  await A.page.click('button[title="Rückgängig"]'); await sleep(2500); await check('A macht rückgängig', 3);
  await sleep(9000); await check('Undo hält nach 9s', 3);
  await draw(B.page); await sleep(4000); await check('B zeichnet nach Undo (Undo darf nicht zurückkommen)', 4);
  await B.page.reload(); await ready(B.page).catch(() => {}); await sleep(8000);
  if (MODE === 'shared') { const k = await B.page.evaluate(() => document.querySelectorAll('#notebook-list > *').length); for (let i = 0; i < k; i++) { await B.page.evaluate(i => document.querySelectorAll('#notebook-list > *')[i].click(), i); await sleep(1500); if (/shared: [^;]*\*/.test(await ov(B.page))) break; } }
  await check('nach Reload von B', 4);
  await A.page.reload(); await ready(A.page).catch(() => {}); await sleep(8000); await check('nach Reload von A', 4);
  for (const [nm, X] of [['A', A], ['B', B]]) { const bad = X.logs.filter(l => /PAGEERROR|^error|ReferenceError|TypeError|fehlgeschlagen/.test(l) && !/User-Initiated Abort|WebRTC blockiert/.test(l)); if (bad.length) { fails++; console.log(`FAIL Fehler in Konsole ${nm}:\n  ` + bad.slice(0, 8).join('\n  ')); } }
  if (process.env.LOGS) { console.log('--- A\n' + A.logs.slice(-30).join('\n')); console.log('--- B\n' + B.logs.slice(-30).join('\n')); }
  await browser.close();
  console.log(fails ? `ERGEBNIS: ${fails} FEHLER` : 'ERGEBNIS: ALLES OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TESTFEHLER', e); process.exit(2); });
