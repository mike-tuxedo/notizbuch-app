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

### Erledigt (Session 2026-03-26/27) — App v2 auf experiment/yjs-sync

- [x] **Modulare Architektur:** app-v2.html + js/ (app.js, canvas.js, storage.js, p2p-sync.js, encryption.js, share.js)
- [x] **Storage:** OPFS + IndexedDB Fallback mit automatischer Feature-Detection
- [x] **Canvas Engine:** Catmull-Rom, Polygon, 3-Layer, Bitmap-Cache, drawBackground
- [x] **UI:** Dark Theme, Sidebar mit Notebook-Liste, Zen-Modus, iro.js Farbwähler
- [x] **Zoom/Pan:** Hand-Tool, Mausrad-Zoom, Pinch-Zoom, fitToContent (Home-Button)
- [x] **Mobile UI:** Burger-Sidebar, Farb-/Größen-Popup unter Toolbar, Notebook-Name in Pagebar
- [x] **Phase 1 — MasterKey + Meta-Sync:** Passphrase → PBKDF2 → Room-ID, Full-Sync bei Peer-Join, CRUD-Broadcast
- [x] **Phase 2 — OPFS-Verschlüsselung:** Strokes mit NotebookKey, Meta mit MasterKey (AES-GCM 256)
- [x] **Phase 3 — Notebook-Sharing:** Invite-Link mit NotebookKey im Fragment, parseInviteLink bei Start
- [x] **Phase 4 — Export/Import:** Passphrase-wrapped .enc Bundle, Download/Upload UI
- [x] **Phase 5 — Touch/Palm-Rejection:** Touch nur bei Hand-Tool, Pen-Erkennung → Touch ignorieren
- [x] **P2P-Sync Stabilität:** Kein Room-Destroy bei Tab-Fokus, Android pointerdown Fallback (>5s)
- [x] **Bugfixes:** Stroke-Versatz (DPR), Canvas-Clear bei Navigation, Duplikat-Notebooks, compositeStrokes Delta

### Erledigt (Session 2026-03-27b) — Features + Relay v2

- [x] **Seite löschen:** deletePage() mit Confirm-Dialog, P2P-Sync (page-deleted), Papierkorb-Button in Page-Bar
- [x] **Hintergrund-Auswahl:** setBackground() mit 3 Icon-Buttons (Kariert/Liniert/Leer) in Page-Bar, P2P-Sync (page-bg), auf Mobile versteckt
- [x] **Relay-Server v2:** js/relay.js Client-Modul, WebSocket Relay speichert nur Ciphertext (Base64). Push nach jedem Save, Pull bei Init, Reconnect bei Tab-Fokus
- [x] **NotebookKey-Sharing:** Keys in verschlüsselter Meta eingebettet (MasterKey). installNotebookKeys() bei loadAppMeta + mergeRelayData. Ohne das konnte Relay-Sync keine Page-Daten entschlüsseln (Key-Mismatch zwischen Geräten)
- [x] **Relay-Reconnect:** handleActivityChange() reconnectet WebSocket + pushAllToRelay() wenn Verbindung tot (Mobile-Browser schließen WS im Hintergrund)

### Nächste Schritte

- [ ] **Mobile-Testing:** Brave Android, Safari iOS, Firefox Android
- [ ] **Firefox Stable:** OPFS `GetDirectory` SecurityError — Fallback auf IndexedDB testen
- [ ] **Snapshots:** Backup/Restore Feature aus alter App übernehmen
- [ ] **Inkrementelles Stroke-Rendering:** Performance-Optimierung (setTransform statt save/restore)
- [ ] **experiment/evolu-sync archivieren:** Branch als abgeschlossen markieren
- [ ] **app-v2.html → app.html:** Wenn stabil, alte app.html ersetzen
