# PLAN.md — Notizbuch App

## Status: metaDb + pageDb Split (Stand 2026-03-24)

### Sync-Architektur

**Zwei GenosDB-Instanzen + Live-Channel + Relay-Snapshot**

```
metaDb (Room: roomKey):
  Notebook Node  { type:'notebook', name }
  Page Meta      { type:'page', notebookId, background, order, clearedAt }

pageDb (Room: roomKey + '_p_' + pageId, wechselt bei Navigation):
  Page Data      { type:'pagedata', strokes:[...] }
```

Drei Sync-Kanäle:
| Kanal | Zweck | Latenz |
|---|---|---|
| `strokeChannel.send()` | Peer sieht Stroke sofort | ~30ms |
| `pageDb.put()` | OPFS-Persistenz (nur aktuelle Seite) | 2s debounce |
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
- [x] **Graph-Migration:** Blob → Node-per-Stroke → Node-per-Page → metaDb+pageDb
  - Node-per-Stroke verworfen (WebRTC Chunk-Limit, Relay-Broadcast-Sturm)
  - Node-per-Page: Strokes eingebettet im Page-Node
  - metaDb+pageDb Split: eigene GenosDB-Instanz pro Seite
  - `mergeNotebooks()`, `compactNotebook()` entfernt
  - Migration: `migrateBlob()` konvertiert altes Blob-Format automatisch
- [x] **Live-Stroke-Channel:** `pageDb.room.channel("stroke-live")` für instant Peer-Sync
- [x] **Inkrementelles Zeichnen:** Neuer Stroke direkt auf Canvas, kein `redrawStrokes()`
- [x] **Stroke-Merge:** Union-by-ID in pageDb.map() Handler, Skip wenn IDs identisch
- [x] **Relay als Snapshot-Store:** Kein Broadcast, nur Speicherung + Init-Load
- [x] **GenosDB-Instanz pro Seite:** metaDb (Metadaten) + pageDb (Strokes, pro Seite)
  - OPFS-Serialisierung nur für aktuelle Seite
  - Full-State-Sync nur für eine Seite (löst WebRTC Chunk-Limit)
  - `openPageDb()` wechselt bei Seitennavigation
- [x] Testbuch-Generator (1000 Strokes) für Performance-Tests

### Nächste Schritte

- [ ] **Mobile-Testing:** Brave Android, Safari iOS, Firefox Android
- [ ] **Firefox Stable:** OPFS `GetDirectory` SecurityError — Fallback-Strategie klären
- [ ] **Relay-Snapshot für pageDb:** Aktuell enthält Relay nur metaDb-Nodes. Strokes nur über GenosDB P2P verfügbar — wenn kein Peer online, fehlen Strokes nach Cache-Clear.
- [ ] **experiment/evolu-sync archivieren:** Branch als abgeschlossen markieren
- [ ] **Edge-Case:** Bei extremer gleichzeitiger Zeichenaktivität (2 Peers zeichnen schnell gleichzeitig) können vereinzelt Strokes durch Merge-Timing verloren gehen. Kein realer Usecase, aber für Game-artige Szenarien relevant.
