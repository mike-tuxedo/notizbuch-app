# PLAN.md — Notizbuch App

## Status: rootDb + pageDb Architektur (Stand 2026-03-25)

### Sync-Architektur

**Zwei GenosDB-Ebenen + Live-Channel + Relay-Snapshot**

```
rootDb (Room: roomKey) — immer offen:
  Notebook Node  { type:'notebook', name }
  Page Node      { type:'page', notebookId, background, order, clearedAt, pageRoom }

pageDb (Room: pageRoom = roomKey + '_p_' + pageId, wechselt bei Navigation):
  Page Data      { type:'pagedata', strokes:[...] }
```

Drei Sync-Kanäle:
| Kanal | Zweck | Latenz |
|---|---|---|
| `strokeChannel.send()` | Peer sieht Stroke sofort | ~30ms |
| `pageDb.put()` | OPFS-Persistenz (nur aktuelle Seite) | sofort (saveDelay: 0) |
| Relay `node-put` | Backup für Offline-Peers | 2s debounce |

Relay-Fallback bei Navigation: `node-get` Request holt Strokes wenn lokal keine vorhanden.

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

### Erledigt (Session 2026-03-25)

- [x] **Rename metaDb → rootDb:** Klarere Benennung der Haupt-GenosDB
- [x] **pageRoom-Referenz:** Explizite Referenz auf pageDb-Room in jedem Page-Node
- [x] **metaDb.link() entfernt:** Notebook→Page Beziehung nur über `notebookId`
- [x] **Init-Lücke gefixt:** Final-Merge von initNodes vor dbInitialized (P2P-Nodes die nach Phase 1 ankamen gingen verloren)
- [x] **Cross-Notebook Stroke-Leak gefixt:** openPageDb bei createNotebook/createTestNotebook/selectNotebook
- [x] **Relay-Merge robust:** Phase 2 immer ausführen, nur neue Nodes in rootDb, Strokes rausfiltern
- [x] **Relay-Server Merge:** `node-put` merged statt überschreibt (bestehende Felder bleiben)
- [x] **Relay-Server `node-get`:** Einzelnen Node abrufen für Fallback bei Seitennavigation
- [x] **Snapshot-Push:** Strokes nur für aktuelle Seite (verhindert Überschreiben mit leeren Strokes)
- [x] **Stale-Guard:** pageDb.map + strokeChannel Callbacks ignorieren Events nach Navigation
- [x] **saveDelay: 0:** Sofortiger OPFS-Write (saveDelay:1000 verursachte Datenverlust bei schnellem Seitenwechsel)
- [x] **Canvas sofort leeren:** redrawStrokes() am Anfang von openPageDb (keine Ghost-Zeichnung der vorherigen Seite)
- [x] **pageLoading-State:** Blockiert Zeichnen während Sync, Wait-Cursor, pulsierender blauer Punkt
- [x] **Notebook-Löschung synchronisiert:** Pages aus rootDb + Relay löschen, rootDb.map Handler räumt auf
- [x] **Relay-Fallback bei Navigation:** node-get Request holt Strokes wenn kein P2P-Peer im Room
- [x] **Zoom-Reset-Button:** Immer sichtbar (v-if entfernt)

### Nächste Schritte

- [ ] **Mobile-Testing:** Brave Android, Safari iOS, Firefox Android
- [ ] **Firefox Stable:** OPFS `GetDirectory` SecurityError — Fallback-Strategie klären
- [ ] **experiment/evolu-sync archivieren:** Branch als abgeschlossen markieren
- [ ] **Edge-Case:** Bei extremer gleichzeitiger Zeichenaktivität (2 Peers zeichnen schnell gleichzeitig) können vereinzelt Strokes durch Merge-Timing verloren gehen. Kein realer Usecase, aber für Game-artige Szenarien relevant.
