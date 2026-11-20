// Test „nicht geladene Seite“: node unloaded-page.cjs <URL>
// Zwei isolierte Browser-Kontexte im Geräte-Sync, echtes P2P. B hat nach einem Neuladen Seite 2 nur als
// Meta im Speicher (Relay für B blockiert). Ein eingehendes Sync-Event für diese Seite darf deren Datei
// nicht mit einem unvollständigen Event-Log überschreiben.
// Neben 'striche: N' wird die Größe der Seitendateien in OPFS geprüft („keine Seitendatei geschrumpft“):
// Wechselt A auf die betroffene Seite, schickt A beim nächsten Resync/Peer-Join deren ganzes Event-Log
// mit und heilt B wieder — die Strichzahl allein würde den Schaden auf der Platte deshalb nicht zeigen.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const URL = process.argv[2] || 'https://localhost:4444/app.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ov = p => p.evaluate(() => document.getElementById('console')?.innerText.replace(/\n/g, ' ; '));
let fails = 0;
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--ignore-certificate-errors'] });
  const mk = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, ignoreHTTPSErrors: true });
    await ctx.addInitScript(() => localStorage.setItem('notizbuch:debugOverlay', '1'));
    const page = await ctx.newPage(); const logs = [];
    page.on('console', m => { const t = m.text(); if (!/WebSocket connection|willReadFrequently|Password field/.test(t)) logs.push(`${m.type()}: ${t.slice(0, 220)}`); });
    page.on('pageerror', e => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
    return { ctx, page, logs };
  };
  const ok = (cond, label) => { if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`); };
  const ready = p => p.waitForFunction(() => /device: [0-9a-f]/.test(document.getElementById('console')?.innerText || ''), null, { timeout: 20000 });
  const cnt = p => p.evaluate(() => { const m = (document.getElementById('console')?.innerText || '').match(/striche: (\d+)/); return m ? Number(m[1]) : -1; });
  // „Seite n von m“ aus dem Zähler der Seiten-Pille
  const pos = p => p.evaluate(() => { const m = (document.getElementById('btn-page-overview')?.getAttribute('aria-label') || '').match(/Seite (\d+) von (\d+)/); return m ? `${m[1]}/${m[2]}` : '?'; });
  const waitPos = async (p, want, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pos(p) === want) return true; await sleep(300); } return false; };
  const waitP2P = async (ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const [a, b] = [await ov(A.page), await ov(B.page)]; if (/↳[^;]*connected/.test(a) && /↳[^;]*connected/.test(b)) return true; await sleep(1000); } return false; };
  // Größe aller Seitendateien von B in OPFS (notebooks/{nbId}/pages/{pageId}.bin), ohne eine Seite zu laden
  const disk = () => B.page.evaluate(async () => { const out = {}; const walk = async (d, p) => { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') await walk(h, p + n + '/'); else if (/pages\/$/.test(p)) out[p + n] = (await h.getFile()).size; } }; await walk(await navigator.storage.getDirectory(), ''); return out; });
  const notShrunk = async (before, label) => { const now = await disk(); const bad = Object.keys(before).filter(k => !(now[k] >= before[k])); const fmt = o => Object.values(o).join('+') || 'keine Dateien';
    ok(Object.keys(before).length >= 2 && !bad.length, `${label}: keine Seitendatei bei B geschrumpft (vorher ${fmt(before)} Bytes, jetzt ${fmt(now)})`); return now; };
  let y = 120;
  const draw = async p => { y += 60; const box = await p.evaluate(() => { const c = document.querySelectorAll('canvas')[2].getBoundingClientRect(); return { x: c.x, y: c.y }; });
    await p.mouse.move(box.x + 150, box.y + y); await p.mouse.down(); for (let i = 0; i <= 20; i++) await p.mouse.move(box.x + 150 + i * 15, box.y + y); await p.mouse.up(); };
  // B neu laden; danach muss B Seite 1 zeigen und (optional) wieder per P2P mit A verbunden sein
  const reloadB = async (p2p) => {
    await B.page.reload(); await ready(B.page).catch(() => {});
    // Alte Peer-Zeile bei A verschwindet erst nach dem Abbruch; kurz warten, dann auf neue Verbindung prüfen
    await sleep(3000);
    return p2p ? await waitP2P() : true;
  };

  const A = await mk(), B = await mk();
  await A.page.goto(URL); await A.page.click('#btn-new-start'); await A.page.click('#btn-key-confirmed'); await ready(A.page); await sleep(3000);
  const keyHex = await A.page.evaluate(() => JSON.parse(localStorage.getItem('notizbuch:masterKeyRaw')).map(b => b.toString(16).padStart(2, '0')).join(''));
  await B.page.goto(URL + '#' + keyHex); await ready(B.page).catch(() => {});
  ok(await waitP2P(), 'P2P verbunden (A und B)');

  // ── Vorbereitung: Seite 2 mit 2 Strichen, bei B auf der Platte ──
  await A.page.click('#btn-add-page'); await sleep(800);
  await draw(A.page); await draw(A.page); await sleep(2500);
  await A.page.click('#btn-prev'); await sleep(500);
  ok(await pos(A.page) === '1/2', `A zeigt wieder Seite 1 von 2 (${await pos(A.page)})`);
  ok(await waitPos(B.page, '1/2'), `B kennt beide Seiten und zeigt Seite 1 (${await pos(B.page)})`);
  await B.page.click('#btn-next'); await sleep(1500);
  { const n = await cnt(B.page); ok(n === 2, `B Seite 2: 2 Striche angekommen: B=${n} (soll 2)`); }
  await sleep(2500); // Speichern (entprellt) abwarten
  await B.page.click('#btn-prev'); await sleep(2000);
  ok(await pos(B.page) === '1/2', `B zeigt wieder Seite 1 (${await pos(B.page)})`);

  let files = await disk();
  ok(Object.keys(files).length === 2 && Object.values(files).some(v => v > 500), `B hat beide Seitendateien, Seite 2 mit Inhalt (${Object.values(files).join('+')} Bytes)`);

  // ── Relay für B blockieren (nur wss://localhost:4444; Nostr-Signaling bleibt frei) ──
  let blocked = 0;
  await B.ctx.routeWebSocket(/^wss?:\/\/localhost:4444/, ws => { blocked++; ws.close({ code: 1011, reason: 'Relay blockiert (Test)' }); });
  const p2pBack = await reloadB(true);
  ok(blocked > 0, `Relay-Verbindungen von B blockiert (${blocked})`);
  ok(await pos(B.page) === '1/2', `B nach Reload: Seite 1 von 2, Seite 2 nur als Meta (${await pos(B.page)})`);
  ok(p2pBack, 'P2P nach Reload von B wieder verbunden');
  await sleep(3000);
  files = await notShrunk(files, 'nach Reload + Peer-Join-full-sync');

  // ── Fall 1: stroke-Event für die nicht geladene Seite ──
  await A.page.click('#btn-next'); await sleep(800);
  { const n = await cnt(A.page); ok(n === 2, `A Seite 2 vor dem neuen Strich: A=${n} (soll 2)`); }
  await draw(A.page); await sleep(3000);
  { const n = await cnt(A.page); ok(n === 3, `A Seite 2 nach dem neuen Strich: A=${n} (soll 3)`); }
  ok(await pos(B.page) === '1/2', `B zeigt beim Empfang Seite 1 (${await pos(B.page)})`);
  files = await notShrunk(files, 'nach stroke für nicht geladene Seite');
  await B.page.click('#btn-next'); await sleep(1500);
  { const n = await cnt(B.page); ok(n === 3, `stroke für nicht geladene Seite: B Seite 2 = ${n} (soll 3)`); }
  await sleep(2500);
  await B.page.click('#btn-prev'); await sleep(2000);
  // Ohne P2P-Warten: es zählt, was bei B auf der Platte liegt
  await reloadB(false);
  ok(await pos(B.page) === '1/2', `B nach 2. Reload: Seite 1 (${await pos(B.page)})`);
  await B.page.click('#btn-next'); await sleep(1500);
  { const n = await cnt(B.page); ok(n === 3, `stroke für nicht geladene Seite, nach Reload: B Seite 2 = ${n} (soll 3)`); }
  await sleep(2500);
  await B.page.click('#btn-prev'); await sleep(2000);

  // ── Fall 2: Meta-full-sync (A legt Seite 3 an), B hat Seite 2 nicht geladen ──
  ok(await reloadB(true), 'P2P nach 3. Reload von B wieder verbunden');
  ok(await pos(B.page) === '1/2', `B frisch geladen: Seite 1 von 2 (${await pos(B.page)})`);
  await sleep(3000);
  files = await notShrunk(files, 'nach 3. Reload + Peer-Join-full-sync');
  await A.page.click('#btn-add-page'); await sleep(3000);
  ok(await pos(A.page) === '3/3', `A hat Seite 3 angelegt (${await pos(A.page)})`);
  ok(await waitPos(B.page, '1/3'), `B kennt Seite 3 (Meta-full-sync angekommen), zeigt Seite 1 (${await pos(B.page)})`);
  files = await notShrunk(files, 'nach Meta-full-sync');
  await B.page.click('#btn-next'); await sleep(1500);
  { const n = await cnt(B.page); ok(n === 3, `Meta-full-sync bei nicht geladener Seite: B Seite 2 = ${n} (soll 3)`); }
  await sleep(2500);
  await B.page.click('#btn-prev'); await sleep(2000);
  await reloadB(false);
  ok(await pos(B.page) === '1/3', `B nach 4. Reload: Seite 1 von 3 (${await pos(B.page)})`);
  await B.page.click('#btn-next'); await sleep(1500);
  { const n = await cnt(B.page); ok(n === 3, `Meta-full-sync bei nicht geladener Seite, nach Reload: B Seite 2 = ${n} (soll 3)`); }

  for (const [nm, X] of [['A', A], ['B', B]]) { const bad = X.logs.filter(l => /PAGEERROR|ReferenceError|TypeError/.test(l) && !/User-Initiated Abort/.test(l)); if (bad.length) { fails++; console.log(`FAIL Fehler in Konsole ${nm}:\n  ` + bad.slice(0, 8).join('\n  ')); } }
  if (process.env.LOGS) { console.log('--- A\n' + A.logs.slice(-40).join('\n')); console.log('--- B\n' + B.logs.slice(-40).join('\n')); }
  await browser.close();
  console.log(fails ? `ERGEBNIS: ${fails} FEHLER` : 'ERGEBNIS: ALLES OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TESTFEHLER', e); process.exit(2); });
