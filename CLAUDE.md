# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Notizbuch** is an offline-first Progressive Web App for handwritten notes with P2P synchronization via WebRTC. No build system — all files are served statically.

- **Language:** German (UI, comments, commit messages)
- **Framework:** petite-vue (lightweight Vue alternative)
- **Database:** GenosDB (CRDT-based sync layer over WebRTC, stored in OPFS)
- **Rendering:** HTML5 Canvas (multi-layer)

## Development

No build step. Serve the root directory with any static HTTP server:

```bash
python -m http.server 8080
# or
npx serve .
```

The app runs at `./app.html`, the landing page at `./index.html`.

**Service Worker:** After changes to static assets, bump `CACHE_NAME` in `sw.js` to invalidate caches.

## Architecture

### Files

- `app.html` (~3150 lines) — The entire app: CSS + HTML template + JS in one file. Contains the petite-vue app, all drawing logic, sync, and UI.
- `index.html` (~1460 lines) — Marketing/landing page, standalone.
- `sw.js` — Service Worker with cache-first + stale-while-revalidate strategy.
- `libs/` — Vendored third-party libraries (all minified except `genosdb.js`).

### Data Model (Graph-Nodes)

Zwei GenosDB-Instanzen: `metaDb` für Metadaten, `pageDb` pro Seite für Strokes.

```
metaDb (Room: roomKey):
  Notebook Node  { type:'notebook', name }
    ↓ metaDb.link(notebookId, pageId)
  Page Meta      { type:'page', notebookId, background, order, clearedAt }

pageDb (Room: roomKey + '_p_' + pageId, wechselt bei Seitennavigation):
  Page Data      { type:'pagedata', strokes:[{id,points,color,size,tool}] }
```

IDs are `String(Date.now())` timestamps. `clearedAt` on page nodes as safety-net for concurrent edits. In-memory model (`this.notebooks[]`) is rebuilt from metaDb graph nodes on init. Strokes der aktuellen Seite werden aus pageDb geladen. Strokes werden per Union-by-ID gemerged wenn Pages von verschiedenen Peers divergieren.

### Storage Layers

1. **GenosDB (2 Instanzen)** — `metaDb`: Notebook/Page-Metadaten (leichtgewichtig). `pageDb`: Strokes der aktuellen Seite (eigener Room pro Seite, wechselt bei Navigation). Beide E2E encrypted via `password`.
2. **IndexedDB** — Device-local settings (color, pen size, page positions, snapshots). Keyed by `{roomKey}:settingName`. Never synced.
3. **Service Worker Cache** — Static assets for offline support.
4. **WebSocket Relay** — Snapshot-Store für Graph-Nodes (kein Broadcast, nur Speicherung). Backup für Peers die später online kommen.

### Sync System

- **Room Key** = URL hash (`#abc123`). Different hash = different sync group.
- **Live-Channel:** `pageDb.room.channel("stroke-live")` sendet Strokes/Undo/Clear instant an Peers (~30ms). Kein `db.put()`, kein structuredClone.
- **Persistenz:** `savePageNode()` debounced (2s) → Metadaten an `metaDb.put()`, Strokes an `pageDb.put()`, Relay-Update. Getrennte OPFS-Files pro Seite.
- **Read path:** `metaDb.map()` für Notebook/Page-Metadaten, `pageDb.map()` für Strokes der aktuellen Seite. Strokes werden per Union-by-ID gemerged.
- **Seitenwechsel:** `openPageDb(pageId)` schließt altes pageDb, öffnet neues mit eigenem Room + strokeChannel.
- Init has two phases: quick local load (600ms), then optional peer wait (up to 8s on shared URLs).

### Canvas Rendering

Three stacked canvases:
1. **bgCanvas** — Grid/lined paper background
2. **staticCanvas** — All committed strokes (mit Bitmap-Cache für Pan/Zoom)
3. **activeCanvas** — Live stroke preview during drawing

**Bitmap-Cache:** `_strokeCacheCanvas` speichert das gerenderte Ergebnis von `redrawStrokes()`. Bei Pan/Zoom wird nur das gecachte Bild transformiert (`compositeStrokes()`), ohne alle Strokes neu zu zeichnen. Bei Pointer-Up und Stroke-Änderungen wird der Cache aktualisiert.

Drawing pipeline: raw points → Catmull-Rom smoothing → polygon with perpendicular offsets for width → fill on canvas. Eraser uses `globalCompositeOperation = 'destination-out'`.

### Input Handling

- Pen (`pointerType === 'pen'`) always accepted; disables touch when detected (palm rejection).
- Pinch-zoom state tracked outside petite-vue reactivity for performance.
- Swipe gesture (≥80px horizontal, <800ms) navigates pages.

## Code Patterns

- Single `createApp({...}).mount('#app')` — all state and methods in one petite-vue object (line ~1738).
- Helper functions (`roundPoints`, `savePageNode`, `openPageDb`, `migrateBlob`, `smoothPoints`, `buildStrokePolygon`, `drawStrokeToCanvas`) live outside the reactive app. `app` Variable auf Module-Level referenziert die petite-vue Instanz.
- `savePageNode()` debounces persistence by 2 seconds. `_flushPageSave()` for immediate save (beforeunload).
- Coordinates stored at 0.1 precision (rounded). DPR capped at 2.
- View transform: `screen = (world * scale) + offset`, scale range 0.2x–8x.

## Branches

- **`main`** — GenosDB + WebSocket Relay (P2P + Relay hybrid)
- **`experiment/evolu-sync`** — Custom sync layer inspired by Evolu (Relay-only, E2E-verschlüsselt, Delta-Sync)

## Relay Server (`relay/`)

Node.js HTTPS + WSS Server für lokale Entwicklung und persistenten Sync:

```bash
cd relay && npm install && node server.js
```

- Serviert statische Files über HTTPS (mkcert-Zertifikat nötig)
- WebSocket Relay als Snapshot-Store (Graph-Nodes, kein Broadcast)
- Debug-Dashboard unter `/debug.html` (nur auf `main`)
- **Daten in `relay/data.json`** — persistiert via debounced JSON-Write + Graceful Shutdown
- LAN-IP wird automatisch erkannt (nicht hardcoded)
- Clients pushen einmalig nach Init einen Snapshot an den Relay
- Message-Typen: `node-put` (speichern), `node-remove` (löschen) — kein Broadcast an andere Peers

### mkcert Setup (einmalig)

```bash
mkcert -cert-file cert.pem -key-file key.pem localhost <LAN-IP>
```

LAN-IP ändert sich je nach WLAN — Zertifikat muss bei Netzwerkwechsel neu erstellt werden.
Für mobile Tests: `rootCA.pem` auf dem Gerät installieren (aus `mkcert -CAROOT`).

## GenosDB — Genutzte Features

- **`password`-Option:** AES-256-GCM E2E-Verschlüsselung. Aktiviert via `gdb(roomKey, { rtc: true, password: roomKey })`.
- **Delta-Sync:** Eingebauter `deltaSync` mit OpLog + Hybrid Logical Clock. Automatischer Delta-Sync pro Instanz.
- **Graph-Datenbank:** Notebooks und Pages als Graph-Nodes mit `metaDb.link()`.
- **Mehrere Instanzen:** `metaDb` + `pageDb` — jede Seite hat eigenen Room und eigenes OPFS-File. Löst OPFS-Serialisierungsproblem und WebRTC Chunk-Limit.
- **Room-Channels:** `pageDb.room.channel("stroke-live")` für ephemere Live-Updates (kein `db.put()` nötig). Pattern aus GenosDB Whiteboard/Collab-Beispielen.
- **`saveDelay`-Option:** Auf 1s gesetzt (default 200ms) um OPFS-Serialisierung seltener auszulösen.

## Sync-Architektur — Entscheidungen

### Sync-Reihenfolge (main): Relay-first, P2P-Fallback
1. Lokal (OPFS/IDB) — instant
2. Relay (WebSocket) — max 3s
3. P2P (WebRTC via GenosDB) — max 5s, nur als Fallback
4. Default-Notebook erstellen — nur wenn alles leer

### Navigations-State via Relay
- `currentNotebookId` + `currentPages` (Seitenpositionen) werden als `_nav`-Eintrag im Relay gespeichert
- Überlebt Browser-Cache-Löschung (IDB wird gelöscht, Relay hat den State)
- Lokaler IDB-State hat Priorität über Relay-State

### Default-Notebook Benennung
- Name enthält Browser + Gerät: z.B. "Notizen Firefox Android", "Notizen Chrome Desktop"
- Erkennung via `navigator.userAgent`

## Bekannte Probleme und Learnings

### Performance bei vielen Strokes
- `redrawStrokes()` zeichnet ALLE Strokes neu (Catmull-Rom + Polygon pro Stroke)
- Bei 1000 Strokes pro Seite spürbar langsam, besonders auf Mobilgeräten
- **Inkrementelles Zeichnen:** Neuer Stroke wird direkt auf Canvas + Bitmap-Cache gezeichnet (kein `redrawStrokes()`). Nur Undo/Clear/Sync lösen Full-Redraw aus.
- **GenosDB OPFS-Serialisierung blockiert Main Thread:** `db.put()` triggert intern `structuredClone` + MessagePack + Pako auf dem Main Thread. `saveDelay: 1000` reduziert Frequenz. Gelöst durch Instanz-pro-Seite (pageDb serialisiert nur eine Seite statt alles).
- **GenosRTC Message-Limit:** Full-State-Sync bei vielen Nodes schlug fehl ("Message too large, exceeds max chunks 100"). Gelöst durch Instanz-pro-Seite (Full-State nur für eine Seite).
- `String.fromCharCode(...largeBuffer)` verursacht Stack-Overflow bei großen verschlüsselten Payloads — Chunk-Verarbeitung nötig
- **petite-vue Proxy-Objekte:** Daten aus dem reaktiven System müssen vor `db.put()` entproxied werden (z.B. `points.map(p => ({x:p.x, y:p.y}))`) — sonst `structuredClone` DOMException.

### Sync-Bugs die gefixt wurden
- Save-Merge Race Condition: Stroke ging verloren wenn Sync-Event während 2s Debounce kam → Fix: immediate save nach Stroke
- Reconnect Data Loss: `location.reload()` ohne vorheriges Speichern → Fix: `_saveAll()` vor Reload
- Leere Seiten mit Custom-Background gingen beim Merge verloren (Filter `strokes.length > 0` entfernt)
- Relay-Push vor WebSocket-Connect: Daten wurden gesendet bevor Verbindung stand → Fix: Wait-Loop
- `_updatedAt`-Metadaten verursachten Endlos-Sync-Loop → Fix: `stripSyncMeta()` für Vergleiche

### Was nicht funktioniert hat
- **Evolu (echtes Paket):** Braucht Build-Step (WASM + Web Workers). Kein CDN-Import möglich wegen `new URL("file", import.meta.url)` Pattern.
- **Performance-Optimierung via Stroke-Caching:** Caching von smoothed Points in `_pts`/`_poly` + inkrementelles Canvas-Update führte zu visuellen Regressions. Reverted.
- **OPFS als persistenterer Speicher:** OPFS und IndexedDB werden bei "Cookies & Websitedaten löschen" identisch gelöscht. Kein Persistenz-Vorteil.
- **Zwei Tabs mit verschiedenen Room-Keys:** GenosDB/OPFS teilt sich Ressourcen pro Origin → Konflikte.
- **Node-per-Stroke Modell:** Jeder Stroke als eigener GenosDB-Node. Full-State-Sync bei >500 Nodes überschreitet WebRTC Chunk-Limit. Relay-Broadcast-Sturm bei vielen Nodes. Umgestellt auf Node-per-Page.
- **Firefox Stable + OPFS:** `GetDirectory` wirft `SecurityError`. GenosDB kann nicht initialisiert werden. App fällt auf Relay-only zurück.
- **Einzelne GenosDB-Instanz für alles:** OPFS-Serialisierung des gesamten Graphs blockiert Main Thread bei vielen Strokes. Gelöst durch metaDb + pageDb Split.
- **Relay als Live-Sync-Kanal:** Broadcast jedes Stroke-Events an alle Peers verursachte Event-Sturm. Relay ist jetzt nur Snapshot-Store (kein Broadcast).

### Service Worker
- `sw.js` nutzt **Network-first für HTML** (Änderungen sofort sichtbar) und Stale-while-revalidate für Libs
- Vorher Cache-first → Firefox zeigte alte Versionen nach Code-Änderungen

## Commit Convention

Imperative, lowercase, concise. Examples from history: "Try fix some sync cases", "Add pen option", "Update presentationpage".
