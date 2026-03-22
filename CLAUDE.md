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

### Data Model

```
Notebook { id, name, pages[] }
  Page { id, strokes[], deletedStrokes[], clearedAt, background }
    Stroke { id, points[{x,y}], color, size, tool }
```

IDs are `String(Date.now())` timestamps. Strokes are never truly removed — deletions use `deletedStrokes[]` array and `clearedAt` timestamps (tombstone pattern for CRDT convergence).

### Storage Layers

1. **GenosDB** — Notebooks, synced via WebRTC P2P. Key = notebook ID, value = full notebook object. Tombstones (`_deleted: true`) for deleted notebooks.
2. **IndexedDB** — Device-local settings (color, pen size, page positions, snapshots). Keyed by `{roomKey}:settingName`. Never synced.
3. **Service Worker Cache** — Static assets for offline support.

### Sync System

- **Room Key** = URL hash (`#abc123`). Different hash = different sync group.
- `mergeNotebooks()` performs union-based merge per page: strokes after `clearedAt` and not in `deletedStrokes` survive.
- `'removed'` actions from peers are intentionally ignored (prevents accidental cascade deletes).
- Init has two phases: quick local load (600ms), then optional peer wait (up to 8s on shared URLs).

### Canvas Rendering

Three stacked canvases:
1. **bgCanvas** — Grid/lined paper background
2. **staticCanvas** — All committed strokes
3. **activeCanvas** — Live stroke preview during drawing

Drawing pipeline: raw points → Catmull-Rom smoothing → polygon with perpendicular offsets for width → fill on canvas. Eraser uses `globalCompositeOperation = 'destination-out'`.

### Input Handling

- Pen (`pointerType === 'pen'`) always accepted; disables touch when detected (palm rejection).
- Pinch-zoom state tracked outside petite-vue reactivity for performance.
- Swipe gesture (≥80px horizontal, <800ms) navigates pages.

## Code Patterns

- Single `createApp({...}).mount('#app')` — all state and methods in one petite-vue object (line ~1738).
- Helper functions (`compactNotebook`, `mergeNotebooks`, `smoothPoints`, `buildStrokePolygon`, `drawStrokeToCanvas`) live outside the reactive app.
- `scheduleSave()` debounces auto-save by 2 seconds.
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
- WebSocket Relay für Notebook-Sync (Store-and-Forward)
- Debug-Dashboard unter `/debug.html` (nur auf `main`)
- **Daten nur im RAM** — Server-Neustart löscht alle Relay-Daten
- Clients pushen ihre lokalen Notebooks nach Connect automatisch an den Relay

### mkcert Setup (einmalig)

```bash
mkcert -cert-file cert.pem -key-file key.pem localhost 192.168.100.49
```

Für mobile Tests: `rootCA.pem` auf dem Gerät installieren (aus `mkcert -CAROOT`).

## GenosDB — Ungenutzte Features (Erkenntnis Session 2026-03-22)

GenosDB hat eingebaute Features die wir nicht nutzen:
- **`password`-Option:** AES-256-GCM E2E-Verschlüsselung (in `genosrtc.min.js`). Aktivierung: `gdb(roomKey, { rtc: true, password: roomKey })`
- **Delta-Sync:** Eingebauter `deltaSync` mit OpLog + Hybrid Logical Clock. Wir nutzen `db.put(ganzes_notebook)` statt granulare Graph-Updates.
- **Graph-Datenbank:** GenosDB ist eine Graph-DB, nicht Key-Value. Jeder Stroke könnte ein eigener Node sein → automatischer Delta-Sync.

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
- Versuch mit Stroke-Caching (`_pts`/`_poly`) und inkrementellem Zeichnen hat zu Regressions geführt und wurde reverted
- `String.fromCharCode(...largeBuffer)` verursacht Stack-Overflow bei großen verschlüsselten Payloads — Chunk-Verarbeitung nötig
- `compactNotebook()` deep-cloned das gesamte Notebook synchron — blockiert bei großen Notebooks

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

### Service Worker
- `sw.js` nutzt **Network-first für HTML** (Änderungen sofort sichtbar) und Stale-while-revalidate für Libs
- Vorher Cache-first → Firefox zeigte alte Versionen nach Code-Änderungen

## Commit Convention

Imperative, lowercase, concise. Examples from history: "Try fix some sync cases", "Add pen option", "Update presentationpage".
