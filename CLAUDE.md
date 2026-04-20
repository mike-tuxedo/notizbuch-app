# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Notizbuch** is an offline-first Progressive Web App for handwritten notes with end-to-end encrypted P2P synchronization via WebRTC. No build system — all files are served statically.

- **Language:** German (UI, comments, commit messages)
- **Rendering:** HTML5 Canvas (multi-layer)
- **Sync:** Trystero P2P (live) + WebSocket Relay (offline backup)
- **Storage:** OPFS (with IndexedDB fallback)
- **Encryption:** AES-GCM 256 (Web Crypto API)

## Development

No build step. Serve the root directory with any static HTTP server. The dev server in `relay/` does this and adds the relay backend.

```bash
cd relay && npm install && node server.js
# → https://localhost:4444/app.html
```

App at `./app.html`, landing page at `./index.html`.

**Service Worker:** Bump `CACHE_NAME` in `sw.js` after changes to static assets.

## File Structure

```
app.html              — UI shell (CSS + HTML, no JS — Dark Theme, 3-Layer Canvas)
index.html            — Marketing landing page (standalone)
sw.js                 — Service Worker (network-first HTML, stale-while-revalidate libs)
manifest.json         — PWA manifest

js/
├── app.js            — State, Init, UI, Input, Navigation, Sync-Integration
├── canvas.js         — Drawing Engine (Catmull-Rom smoothing, polygon fill)
├── storage.js        — OPFS + IndexedDB Fallback
├── encryption.js     — AES-GCM 256 wrapper (generate/import/export/encrypt/decrypt)
├── p2p-sync.js       — Trystero multi-room P2P (Nostr signaling)
├── relay.js          — WebSocket relay client (backup snapshots)
└── share.js          — Export/Import .enc bundle (passphrase-protected)

libs/                 — Vendored third-party libs (iro.js, qrcode.js, petite-vue)
relay/                — Local dev server (HTTPS + WSS + static files, mkcert)
relay-plesk/          — Production relay (standalone WebSocket on Plesk)
```

## Sync Architecture

Three independent layers — **P2P for live sync, Relay for offline backup**:

### 1. Nostr Relays (Signaling only)

5 public Nostr relays for **Trystero peer discovery only**:
`damus.io`, `nos.lol`, `nostr.wine`, `primal.net`, `purplepag.es`

We do NOT host our own Nostr relay. Trystero needs only one working relay for WebRTC signaling. List in `js/p2p-sync.js`.

### 2. WebRTC P2P (Trystero, Multi-Room)

**Direct peer-to-peer for live sync** — strokes, undo, page events.

- **Main Room** (`masterKeyHash`): All own devices. Full app-state sync.
- **Shared Rooms** (one per shared notebook, `notebookHash`): Sharer + recipient(s) of a specific notebook.

`p2p-sync.js` exposes `initP2P` (main), `joinSharedRoom`/`leaveSharedRoom` (per notebook), `send` (target-room aware), `sendToAll`. `p2pSendForNotebook(action, data)` in app.js sends to main + matching shared room.

**Actions:** `stroke`, `undo`, `clear`, `full-sync`, `nb-created`, `nb-deleted`, `nb-renamed`, `page-created`, `page-deleted`, `page-bg`

**Cross-user notebook ID mapping:** Sharer and recipient have different local `notebookId` for the same notebook. `_resolveNbId(eventNbId, roomId)` maps incoming events from a shared room to the local notebookId via `notebookHash`.

### 3. WebSocket Relay (Backup snapshot store)

`wss://notes.mike.fm-media-staging.at` (Plesk-hosted, code in `relay-plesk/`).

**Purpose:** Encrypted blob storage for offline peers — when a peer comes online later, they fetch missed updates from here.

- Server sees only ciphertext (Base64 strings)
- 30-day room TTL
- Message types: `join`, `node-put`, `node-get`, `node-remove`
- **No broadcast** — just storage and retrieval

**Two room types** (server doesn't know the difference):
- `masterKeyHash` → own devices' shared backup
- `notebookHash` → per-shared-notebook backup (parallel to P2P shared room)

**Push patterns:**
- Main relay: `_flushSave()` debounced 1s after stroke → `relayPut(p:{nbId}/{pageId}, ciphertext)`
- Shared room: debounced 3s, **fetch-merge-push** (fetch room first, merge, push union — prevents overwriting peer's data)

## Key Hierarchy

```
MasterKey (AES-GCM 256, randomly generated — NO passphrase)
  ├── encrypts meta.bin (notebook structure + all NotebookKeys)
  ├── SHA-256(MasterKey)[0:16] = masterKeyHash
  │     → P2P main room, Relay main room
  │     → URL hash for full device sync: #{full-key-hex} (64 chars = full 32-byte key)
  │
  └── NotebookKey per notebook (AES-GCM 256, random)
        ├── encrypts stroke data (OPFS + Relay)
        └── SHA-256(NotebookKey)[0:16] = notebookHash
              → P2P shared room, Relay shared room
              → URL hash for navigation: #nb-{notebookHash}
              → Share link: #nb-{hash}&k={base64-key}&name={name}
```

### URL Formats

| URL | Effect |
|---|---|
| `app.html` | Open last notebook, or first-start dialog if no key |
| `app.html#nb-{hash}` | Open specific notebook (must have local key) |
| `app.html#{64-hex-key}` | Import full MasterKey → device sync. Auto-applied, no dialog. |
| `app.html#nb-{hash}&k={key}&name={name}` | Notebook invite link. Imports NotebookKey, joins shared room. |

### Storage Locations

- **OPFS:** Encrypted strokes per page (`notebooks/{nbId}/pages/{pageId}.bin`) + meta.bin
- **localStorage:** `notizbuch:masterKeyHash`, `notizbuch:masterKeyRaw`, `notizbuch:nbKey:{id}`, `notizbuch:sharedNotebooks`
- **IndexedDB (`notizbuch-settings`):** Device-local UI settings (color, pen size, page positions, etc.) keyed by masterKeyHash

## Canvas

3 stacked canvases:
1. **bgCanvas** — Grid/lined paper background
2. **staticCanvas** — Committed strokes (with bitmap-cache for pan/zoom)
3. **activeCanvas** — Live stroke preview during drawing

Drawing pipeline: raw points → Catmull-Rom smoothing → polygon with perpendicular offsets → fill. Eraser uses `globalCompositeOperation = 'destination-out'` (strokes stay in array, just hidden visually).

**Bitmap cache:** `redrawStrokes()` renders to `strokeCacheCanvas`, `compositeStrokes()` transforms cache for pan/zoom without re-rendering all strokes.

**fitToContent:** Pixel-based — renders strokes (incl. eraser) to temp canvas, scans non-transparent pixels for bounding box. Correctly excludes erased areas. Called only on page switch, notebook switch, init, home button — never on sync events.

## Input

- **Pen** (`pointerType === 'pen'`) always draws regardless of tool.
- **Pen-only mode** (sidebar toggle): completely ignores touch in pen/eraser tools.
- **Touch** in pen/eraser tool: 1 finger draws. (`penOnlyMode` blocks this.)
- **Touch** in hand tool: 1 finger pans, 2 fingers pinch-zoom.
- **No swipe page navigation** — explicit gestures removed.
- DPR capped at 2.

## Notebook Management

- **Hover (desktop)**: rename (pencil) + delete (X) icons appear on notebook in sidebar
- **Longpress (touch)**: 500ms hold → context menu with rename/delete
- **Inline rename**: input replaces name text in sidebar list

## Undo

`undo()` removes last stroke + adds ID to `_undoneIds` Set. All union-merge paths (P2P full-sync, relay merge, page load, shared merge) skip strokes in `_undoneIds`. Saves immediately (no debounce) so relay/peers see the new state.

## Relay Server (relay-plesk/)

Standalone WebSocket on Plesk. **Critical setup:**

1. Use `WebSocket.Server({ port })` — NOT `{ server }`. Passenger doesn't pass WS upgrades to a custom HTTP server.
2. **Disable nginx proxy in Plesk** for the domain (otherwise nginx swallows the WS upgrade and returns 200). Ref: https://support.plesk.com/hc/en-us/articles/12377246437399
3. Client connects without port: `wss://domain/`. Plesk routes 443 to the Node process internally.
4. `node-put` with Base64 string (not object) → server replaces, doesn't merge. Ciphertext stored 1:1.

## Local Dev Relay (relay/)

HTTPS + WSS + static files for local development. Needs mkcert certificates:

```bash
mkcert -cert-file cert.pem -key-file key.pem localhost <LAN-IP>
```

LAN-IP changes per WiFi → cert must be regenerated. For mobile tests: install `rootCA.pem` (from `mkcert -CAROOT`) on the device.

## Code Patterns

- All app state in single `state` object in `app.js` (line ~33)
- DOM refs as module-level `let` variables, populated in `init()`
- IDs are `String(Date.now())` timestamps
- Coordinates rounded to 0.1 precision before save
- View transform: `screen = (world * scale) + offset`, scale 0.2x–8x
- Debounced saves: `saveCurrentPage()` 1s, shared relay push 3s, settings on each change

## Known Issues / Won't-fix

- **Concurrent shared edits** are race-prone (~500ms window between fetch and push). Sub-second simultaneous strokes from two peers can lose one. Acceptable for typical async editing.
- **Empty pages** in shared notebooks: `pushSharedNotebook` only pushes pages with strokes. Empty pages exist only in meta. Recipient creates them from meta.
- **Firefox Stable + OPFS:** `GetDirectory` throws `SecurityError`. Falls back to IndexedDB.
- **Public Nostr relays go offline.** List in `p2p-sync.js` needs occasional pruning. Trystero needs only one working relay.
- **Firefox `network.websocket.enabled`** can be reset to `false` by updates/profile reset → all WebSockets fail.

## Commit Convention

Imperative, lowercase, concise. Examples: "Add pen-only mode toggle", "Fix shared notebook sync", "Remove dead Nostr relays".
