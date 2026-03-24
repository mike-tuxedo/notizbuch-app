# PLAN.md — Notizbuch App

## Status: GenosDB Graph-Sync (Stand 2026-03-23)

### Sync-Architektur

**GenosDB Graph-Node-per-Stroke + WebSocket Relay als Backup**

Jeder Stroke, jede Seite und jedes Notebook ist ein eigener GenosDB Graph-Node.
Delta-Sync sendet automatisch nur geänderte Nodes (~200 Bytes pro Stroke statt ganzes Notebook).

```
Notebook Node  { type:'notebook', name }
  ↓ db.link(notebookId, pageId)
Page Node      { type:'page', notebookId, background, order, clearedAt }
  ↓ db.link(pageId, strokeId)
Stroke Node    { type:'stroke', pageId, points, color, size, tool }
```

- E2E-Verschlüsselung via `password`-Option (AES-256-GCM)
- Relay speichert einzelne Graph-Nodes (nicht Notebook-Blobs)
- `mergeNotebooks()` entfällt — GenosDB merged automatisch via HLC
- `compactNotebook()` entfällt — Koordinaten-Rounding inline bei Stroke-Erstellung

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

### Erledigt (Session 2026-03-23)

- [x] GenosDB `password`-Option aktiviert (E2E-Verschlüsselung)
- [x] Relay-Persistenz: JSON-File (`relay/data.json`, debounced + graceful shutdown)
- [x] Canvas-Performance: Bitmap-Cache für Pan/Zoom (`compositeStrokes()`)
- [x] LAN-IP automatisch erkennen (nicht mehr hardcoded)
- [x] **Graph-Migration:** Blob-Storage → Node-per-Stroke
  - Write-Pfad: `db.put()` + `db.link()` pro Stroke/Page/Notebook
  - Read-Pfad: `db.map()` Subscription dispatcht nach `value.type`
  - Undo: `db.remove(strokeId)` statt `deletedStrokes[]`
  - Migration: Altes Blob-Format wird automatisch in Graph-Nodes konvertiert
  - Relay: Node-Level Storage statt Notebook-Blobs
  - `mergeNotebooks()`, `compactNotebook()`, `scheduleSave()` entfernt

### Nächste Schritte

- [ ] **Graph-Sync testen:** Zwei Peers, Stroke-Sync, Undo, Page-Clear
- [ ] **Performance testen:** Bitmap-Cache + Graph-Sync auf Mobilgeräten
- [ ] **Mobile-Testing:** Brave Android, Safari iOS, Firefox Android
- [ ] **experiment/evolu-sync archivieren:** Branch als abgeschlossen markieren
- [ ] **Alte data.json löschen:** `relay/data.json` enthält evtl. altes Blob-Format
