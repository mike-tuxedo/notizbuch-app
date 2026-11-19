// Prüft, ob die TURN-Server aus dem Endpunkt wirklich Daten weiterleiten (iceTransportPolicy: 'relay').
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true });
  const p = await (await b.newContext()).newPage();
  await p.goto('https://notizbuch-app.vercel.app/index.html');
  const res = await p.evaluate(async () => {
    const all = (await (await fetch('https://turnserver.fm-media.at/', { cache: 'no-store' })).json()).iceServers;
    const turns = all.filter(s => [].concat(s.urls).some(u => /^turns?:/.test(u)));
    const one = async (label, iceServers) => {
      const cfg = { iceServers, iceTransportPolicy: 'relay' };
      const a = new RTCPeerConnection(cfg), c = new RTCPeerConnection(cfg);
      const cands = [];
      a.onicecandidate = e => { if (e.candidate) { cands.push(e.candidate.type + '/' + e.candidate.protocol); c.addIceCandidate(e.candidate); } };
      c.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate);
      const ch = a.createDataChannel('t'); const t0 = performance.now();
      const got = new Promise(r => { c.ondatachannel = ev => { ev.channel.onmessage = m => r(m.data); }; });
      ch.onopen = () => ch.send('ping');
      await a.setLocalDescription(await a.createOffer()); await c.setRemoteDescription(a.localDescription);
      await c.setLocalDescription(await c.createAnswer()); await a.setRemoteDescription(c.localDescription);
      const r = await Promise.race([got, new Promise(r => setTimeout(() => r(null), 12000))]);
      let pair = '-';
      (await a.getStats()).forEach(s => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s.id; });
      const st = await a.getStats(); let types = '-';
      if (pair !== '-') { const pr = st.get(pair); types = st.get(pr.localCandidateId).candidateType + '/' + st.get(pr.remoteCandidateId).candidateType + ' ' + st.get(pr.localCandidateId).protocol + ' relayProto=' + (st.get(pr.localCandidateId).relayProtocol || '-'); }
      a.close(); c.close();
      return `${label}: ${r === 'ping' ? 'OK' : 'FEHLGESCHLAGEN'} in ${Math.round(performance.now() - t0)}ms | Kandidaten: ${[...new Set(cands)].join(',') || 'keine'} | Paar: ${types}`;
    };
    const out = [];
    for (const s of turns) for (const u of [].concat(s.urls)) out.push(await one(u.replace(/^turns?:/, ''), [{ ...s, urls: [u] }]));
    return out;
  });
  console.log(res.join('\n'));
  await b.close();
})().catch(e => { console.error('TESTFEHLER', e); process.exit(1); });
