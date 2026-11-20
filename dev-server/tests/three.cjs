// Drei Peers, Teilnetz: node three.cjs <URL>
// L = "Laptop" (Key K1, teilt Notizbuch), P = "Handy" (eigener Key, Share-Link), T = "Tablet" (Key K1 = Gerätesync).
// P blockiert nach dem Verbinden mit L alle weiteren WebRTC-Verbindungen → P und T haben KEINE direkte Verbindung.
// Erwartung: L leitet Striche zwischen T und P weiter.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const URL = process.argv[2] || 'https://localhost:4444/app.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ov = p => p.evaluate(() => document.getElementById('console')?.innerText.replace(/\n/g, ' ; ') || '');
let fails = 0;
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--ignore-certificate-errors'] });
  const mk = async (block) => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, ignoreHTTPSErrors: true });
    await ctx.addInitScript(() => localStorage.setItem('notizbuch:debugOverlay', '1'));
    if (block) await ctx.addInitScript(() => {
      const orig = RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription = function (...a) {
        if (sessionStorage.getItem('blockRtc') === '1' && !this.__allowed) return Promise.reject(new Error('blockiert (Test)'));
        this.__allowed = true; return orig.apply(this, a);
      };
    });
    const page = await ctx.newPage(); const logs = [];
    page.on('console', m => logs.push(m.text().slice(0, 200)));
    return { page, logs };
  };
  const ready = p => p.waitForFunction(() => /device: [0-9a-f]/.test(document.getElementById('console')?.innerText || ''), null, { timeout: 20000 });
  const fresh = async X => { await X.page.goto(URL); await X.page.click('#btn-new-start'); await X.page.click('#btn-key-confirmed'); await ready(X.page); };
  const openShared = async p => { const n = await p.evaluate(() => document.querySelectorAll('#notebook-list > *').length); for (let i = 0; i < n; i++) { await p.evaluate(i => document.querySelectorAll('#notebook-list > *')[i].click(), i); await sleep(1500); if (/shared: [^;]*\*/.test(await ov(p))) return; } };
  const peers = async p => [...new Set(((await ov(p)).match(/↳ (\w+) \w+ connected/g) || []).map(s => s.split(' ')[1]))].length;
  const waitPeers = async (p, n, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await peers(p) >= n) return true; await sleep(1000); } return false; };

  const L = await mk(false), P = await mk(true), T = await mk(false);
  await fresh(L); await sleep(3000);
  await L.page.click('#btn-page-menu'); await L.page.click('#btn-share'); await sleep(1500);
  const link = await L.page.evaluate(() => document.getElementById('share-link').value);
  await L.page.evaluate(() => document.getElementById('share-modal')?.classList.add('hidden'));
  const keyHex = await L.page.evaluate(() => JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw')).map(b => b.toString(16).padStart(2, '0')).join(''));
  // Handy: eigener Key, dann Share-Link
  await fresh(P); await sleep(2000);
  await P.page.goto(URL + link.slice(link.indexOf('#'))); await P.page.reload(); await sleep(6000); await openShared(P.page);
  console.log('P↔L verbunden:', await waitPeers(P.page, 1));
  await P.page.evaluate(() => sessionStorage.setItem('blockRtc', '1'));   // ab jetzt keine neuen Verbindungen am Handy
  // Tablet: gleicher Key wie Laptop
  await T.page.goto(URL + '#' + keyHex); await ready(T.page).catch(() => {}); await sleep(5000); await openShared(T.page);
  console.log('L hat 2 Peers:', await waitPeers(L.page, 2), '| T↔L verbunden:', await waitPeers(T.page, 1));
  await sleep(8000);
  const [pl, pp, pt] = [await peers(L.page), await peers(P.page), await peers(T.page)];
  console.log(`Topologie (Anzahl verbundener Peers): L=${pl} P=${pp} T=${pt}  ${pl === 2 && pp === 1 && pt === 1 ? '→ Teilnetz wie gewünscht' : '→ ACHTUNG: nicht das gewünschte Teilnetz'}`);

  const cnt = p => p.evaluate(() => { const m = (document.getElementById('console')?.innerText || '').match(/striche: (\d+)/); return m ? Number(m[1]) : -1; });
  let y = 100;
  const draw = async p => { y += 50; const box = await p.evaluate(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); return { x: c.x, y: c.y }; });
    await p.mouse.move(box.x + 150, box.y + y); await p.mouse.down(); for (let i = 0; i <= 20; i++) await p.mouse.move(box.x + 150 + i * 15, box.y + y); await p.mouse.up(); };
  const check = async (label, want) => { const v = [await cnt(L.page), await cnt(P.page), await cnt(T.page)]; const ok = v.every(x => x === want); if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: L=${v[0]} P=${v[1]} T=${v[2]} (soll ${want})`); };
  await draw(L.page); await sleep(2500); await check('Laptop zeichnet', 1);
  await draw(P.page); await sleep(2500); await check('Handy zeichnet (L leitet an T weiter)', 2);
  await draw(T.page); await sleep(2500); await check('Tablet zeichnet (L leitet an P weiter)', 3);
  await draw(T.page); await draw(T.page); await sleep(2500); await check('Tablet zeichnet 2 weitere', 5);
  await T.page.click('#btn-undo'); await sleep(2500); await check('Tablet macht rückgängig', 4);
  await P.page.click('#btn-undo'); await sleep(2500); await check('Handy macht rückgängig', 3);
  if (process.env.LOGS) for (const [n, X] of [['L', L], ['P', P], ['T', T]]) console.log(`--- ${n}\n` + X.logs.filter(l => !/WebSocket|willRead|Password/.test(l)).slice(-15).join('\n'));
  await browser.close();
  console.log(fails ? `ERGEBNIS: ${fails} FEHLER` : 'ERGEBNIS: ALLES OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TESTFEHLER', e); process.exit(2); });
