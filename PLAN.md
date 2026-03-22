# PLAN.md — Notizbuch App

## Status: Entscheidung offen (Stand 2026-03-22)

### Kernfrage: Sync-Architektur

Zwei Varianten existieren parallel:

1. **`main`** — GenosDB (P2P) + eigener WebSocket Relay
2. **`experiment/evolu-sync`** — Eigener Relay mit E2E (AES-256-GCM) + Delta-Sync

**Erkenntnis Ende Session:** GenosDB hat E2E (`password`-Option) und Delta-Sync (`deltaSync` + OpLog) eingebaut, wird aber aktuell nur als dummer Key-Value-Store genutzt. Bevor die Entscheidung fällt, sollte geprüft werden ob GenosDB mit Graph-Struktur (ein Node pro Stroke) + `password`-Option die gleichen Vorteile bietet.

### Offene Entscheidung

- [ ] GenosDB mit `password` + granularen Graph-Updates testen (E2E + Delta built-in?)
- [ ] Oder: Eigenen Relay-Ansatz weiterverfolgen (mehr Kontrolle, kein WebRTC)
- [ ] Entscheidung treffen: Ein Ansatz, nicht zwei parallel

### Erledigt (Session 2026-03-22)

- [x] Sync-Bugs auf main gefixt (Save-Merge Race, Reconnect, Merge-Logik)
- [x] WebSocket Relay Server gebaut (relay/)
- [x] HTTPS Dev-Server mit mkcert für mobile Tests
- [x] Evolu-Experiment in eigenem Branch (app-evolu.html)
- [x] E2E-Verschlüsselung (AES-256-GCM) im Evolu-Branch
- [x] Delta-Sync Protokoll (stroke:add, stroke:remove, page:clear, etc.)
- [x] Share-Link mit QR-Code + LAN-IP Erkennung
- [x] Network-first Service Worker (HTML sofort aktuell)
- [x] Browser/Gerät-Name für Default-Notebooks
- [x] Relay-first Sync (3s), P2P als Fallback (5s)
- [x] Nav-State via Relay (überlebt Cache-Clear)
- [x] Debug-Dashboard (debug.html, nur main)
- [x] Evolu (echtes Paket) evaluiert → braucht Build-Step, nicht praktikabel

### Nächste Schritte

- [ ] **Relay-Persistenz:** JSON-File statt RAM (überlebt Server-Neustart)
- [ ] **Performance:** Canvas-Rendering bei vielen Strokes optimieren (OffscreenCanvas? WebGL? Tile-basiert?)
- [ ] **GenosDB Graph-Modus testen:** Strokes als individuelle Nodes statt ganzes Notebook als ein Blob
- [ ] **GenosDB password-Option testen:** `gdb(roomKey, { rtc: true, password: roomKey })`
- [ ] **Mobile-Testing:** Brave Android, Safari iOS, Firefox Android systematisch testen
