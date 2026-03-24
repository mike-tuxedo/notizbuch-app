# PLAN.md — Notizbuch App

## Status: GenosDB Node-per-Page + Live-Channel (Stand 2026-03-24)

### Sync-Architektur

**GenosDB Node-per-Page + Live-Channel + Relay-Snapshot**

Strokes sind im Page-Node eingebettet. Live-Sync über Room-Channel, Persistenz über db.put().

```
Notebook Node  { type:'notebook', name }
  ↓ db.link(notebookId, pageId)
Page Node      { type:'page', notebookId, background, order, clearedAt, strokes:[...] }
```

Drei Sync-Kanäle:
| Kanal | Zweck | Latenz |
|---|---|---|
| `strokeChannel.send()` | Peer sieht Stroke sofort | ~30ms |
| `savePageNode()` → `db.put()` | OPFS-Persistenz | 2s debounce |
| Relay `node-put` | Backup für Offline-Peers | 2s debounce |

### Erledigt (Session 2026-03-22)

- [x] Sync-Bugs auf main gefixt (Save-Merge Race, Reconnect, Merge-Logik)
- [x] WebSocket Relay Server gebaut (relay/)
- [x] HTTPS Dev-Server mit mkcert für mobile Tests
- [x] Evolu-Experiment in eigenem Branch (app-evolu.html)
- [x] Share-Link mit QR-Code + LAN-IP Erkennung
- [x] Network-first Service Worker (HTML sofort aktuell)
- [x] Browser/Gerät-Name für Default-Notebooks
- [x] Relay-first Sync (3s), P2P als Fallback (5s)
- [x] Nav-State via Relay (überlebt Cache-Clear)
- [x] Debug-Dashboard (debug.html, nur main)

### Erledigt (Session 2026-03-23/24)

- [x] GenosDB `password`-Option aktiviert (E2E-Verschlüsselung)
- [x] Relay-Persistenz: JSON-File (`relay/data.json`, debounced + graceful shutdown)
- [x] Canvas-Performance: Bitmap-Cache für Pan/Zoom (`compositeStrokes()`)
- [x] LAN-IP automatisch erkennen (nicht mehr hardcoded)
- [x] **Graph-Migration:** Blob → Node-per-Stroke → Node-per-Page
  - Node-per-Stroke verworfen (WebRTC Chunk-Limit, Relay-Broadcast-Sturm)
  - Node-per-Page: Strokes eingebettet im Page-Node
  - `mergeNotebooks()`, `compactNotebook()` entfernt
  - Migration: `migrateBlob()` konvertiert altes Blob-Format automatisch
- [x] **Live-Stroke-Channel:** `db.room.channel("stroke-live")` für instant Peer-Sync
- [x] **Inkrementelles Zeichnen:** Neuer Stroke direkt auf Canvas, kein `redrawStrokes()`
- [x] **Stroke-Merge:** Union-by-ID bei divergierten Pages, Skip wenn IDs identisch
- [x] **Deferred Updates:** `db.map()` Page-Updates während Zeichnen aufgeschoben
- [x] **Relay als Snapshot-Store:** Kein Broadcast, nur Speicherung + Init-Load
- [x] Testbuch-Generator (1000 Strokes) für Performance-Tests

### Nächste Schritte

- [ ] **GenosDB-Instanz pro Seite:** Eigener Room pro Page (`roomKey_page_pageId`) → löst OPFS-Serialisierungsproblem (nur aktuelle Seite wird serialisiert) + WebRTC Chunk-Limit (kleinere Full-State-Payloads)
- [ ] **Performance testen:** Bitmap-Cache + Node-per-Page auf Mobilgeräten
- [ ] **Mobile-Testing:** Brave Android, Safari iOS, Firefox Android
- [ ] **Firefox Stable:** OPFS `GetDirectory` SecurityError — Fallback-Strategie klären
- [ ] **experiment/evolu-sync archivieren:** Branch als abgeschlossen markieren
