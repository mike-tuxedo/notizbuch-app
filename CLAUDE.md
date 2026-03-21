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

## Commit Convention

Imperative, lowercase, concise. Examples from history: "Try fix some sync cases", "Add pen option", "Update presentationpage".
