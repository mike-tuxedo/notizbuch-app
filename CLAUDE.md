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

### Data Model (2-Ebenen GenosDB)

Zwei GenosDB-Ebenen: `rootDb` für die Notebook/Page-Struktur, `pageDb` pro Seite für Strokes.

```
rootDb (Room: roomKey) — immer offen:
  Notebook Node  { type:'notebook', name }
  Page Node      { type:'page', notebookId, background, order, clearedAt, pageRoom }

pageDb (Room: pageRoom = roomKey + '_p_' + pageId, wechselt bei Seitennavigation):
  Page Data      { type:'pagedata', strokes:[{id,points,color,size,tool}] }
```

Jeder Page-Node enthält `pageRoom` als explizite Referenz auf den Room seiner pageDb-Instanz. Notebook→Page Beziehung über `notebookId` (kein `link()`).

IDs are `String(Date.now())` timestamps. `clearedAt` on page nodes as safety-net for concurrent edits. In-memory model (`this.notebooks[]`) is rebuilt from rootDb graph nodes on init. Strokes der aktuellen Seite werden aus pageDb geladen. Strokes werden per Union-by-ID gemerged wenn Pages von verschiedenen Peers divergieren.

### Storage Layers

1. **GenosDB (2 Ebenen)** — `rootDb`: Notebook/Page-Struktur (leichtgewichtig, immer offen). `pageDb`: Strokes der aktuellen Seite (eigener Room pro Seite, wechselt bei Navigation). Beide E2E encrypted via `password`.
2. **IndexedDB** — Device-local settings (color, pen size, page positions, snapshots). Keyed by `{roomKey}:settingName`. Never synced.
3. **Service Worker Cache** — Static assets for offline support.
4. **WebSocket Relay** — Snapshot-Store für Graph-Nodes (kein Broadcast, nur Speicherung). Backup für Peers die später online kommen.

### Sync System

- **Room Key** = URL hash (`#abc123`). Different hash = different sync group.
- **Live-Channel:** `pageDb.room.channel("stroke-live")` sendet Strokes/Undo/Clear instant an Peers (~30ms). Kein `db.put()`, kein structuredClone.
- **Persistenz:** `savePageNode()` debounced (2s) → Metadaten an `rootDb.put()`, Strokes an `pageDb.put()`, Relay-Update. Getrennte OPFS-Files pro Seite.
- **Read path:** `rootDb.map()` für Notebook/Page-Struktur, `pageDb.map()` für Strokes der aktuellen Seite. Strokes werden per Union-by-ID gemerged.
- **Seitenwechsel:** `openPageDb(pageId)` schließt altes pageDb, öffnet neues mit eigenem Room + strokeChannel. Canvas wird sofort geleert (redrawStrokes vor async Load).
- **Relay-Fallback bei Navigation:** Wenn eine Seite keine lokalen Strokes hat, werden diese vom Relay via `node-get` Request geholt (löst: Peer A zeichnet + blättert weg, Peer B öffnet Seite ohne P2P-Room).
- **Stale-Guard:** pageDb.map + strokeChannel Callbacks prüfen `pageDb !== thisDb` um Events von alten pageDb-Instanzen zu ignorieren (verhindert Seiten-Verwechslung bei schnellem Blättern).
- **pageLoading-State:** Blockiert Zeichnen während Sync läuft (verhindert Merge-Konflikte). Zeigt Wait-Cursor + pulsierenden blauen Punkt.
- Init has three phases: quick local load (600ms), Relay merge (immer, max 3s), P2P fallback (max 5s).

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

- **`main`** — GenosDB + WebSocket Relay (P2P + Relay hybrid). Alte monolithische Architektur (alles in app.html).
- **`experiment/evolu-sync`** — Custom sync layer inspired by Evolu (Relay-only, E2E-verschlüsselt, Delta-Sync)
- **`experiment/yjs-sync`** — **Aktive Entwicklung.** Komplett neue modulare Architektur (DrawPad-inspiriert). Siehe unten.

## App v2 — Modulare Architektur (experiment/yjs-sync)

Trotz Branch-Name wird **nicht** Yjs verwendet. Die Architektur basiert auf dem DrawPad-Proof-of-Concept.

### Dateistruktur

```
app-v2.html           — UI (Dark Theme, Sidebar links, 3-Layer Canvas)
js/
├── app.js            — State, Init, Canvas, Input, UI, Navigation, P2P/Relay-Integration
├── canvas.js         — Drawing Engine (Catmull-Rom, Polygon, Background)
├── storage.js        — OPFS + IndexedDB Fallback (automatische Feature-Detection)
├── p2p-sync.js       — Trystero P2P (Nostr Signaling, WebRTC DataChannel)
├── relay.js          — WebSocket Relay Client (Ciphertext-Backup für Offline-Peers)
├── encryption.js     — AES-GCM 256 (Web Crypto API, PBKDF2 Key-Derivation)
└── share.js          — Invite-Links, QR, Export/Import (.enc Bundle)
```

### Schlüssel-Hierarchie

```
MasterKey (AES-GCM 256, zufällig generiert — KEIN Passphrase)
  ├── verschlüsselt meta.bin (Notebook-Struktur + alle NotebookKeys)
  ├── SHA-256(MasterKey)[0:16] = masterKeyHash
  │     → Relay-Room, P2P-Room (eigene Geräte)
  │
  └── NotebookKey pro Notebook (AES-GCM 256, zufällig)
        ├── verschlüsselt Stroke-Daten (OPFS + Relay)
        └── SHA-256(NotebookKey)[0:16] = notebookHash
              → URL-Hash: #nb-{notebookHash}
              → Share-Link: #nb-{hash}&k={base64}&name={name}
```

- **MasterKey**: Zufällig generiert bei Erst-Start. User muss Key sichern (Hex anzeigen + .txt Download). Gleicher Key auf anderem Gerät = gleicher Sync-Room. Import via Hex-Eingabe oder Datei-Upload.
- **NotebookKey**: Pro Notebook. Wird beim Teilen im URL-Fragment übergeben.
- **URL-Hash**: `#nb-{notebookHash}` zeigt aktuelles Notebook. Ändert sich bei Navigation. `hashchange`-Listener für manuelle URL-Eingabe. Altes Format `#nb={id}&k={key}` wird auch erkannt.
- **Key-Sharing**: NotebookKeys in verschlüsselter Meta eingebettet (MasterKey-verschlüsselt). `installNotebookKeys()` bei `loadAppMeta()` + `mergeRelayData()`.
- Keys in localStorage (raw bytes als JSON-Array).

### P2P-Sync (Trystero)

- **Library:** Trystero via `esm.sh/trystero/nostr` (kein eigener Signaling-Server)
- **Room-ID:** Hash des MasterKeys (alle eigenen Geräte im selben Room)
- **Actions:** stroke, undo, clear, full-sync, nb-created, nb-deleted, nb-renamed, page-created, page-deleted, page-bg
- **Full-Sync:** Bei Peer-Join wird kompletter State gesendet (alle Notebooks, Pages, Strokes). Union-Merge by ID.
- **Kein Room-Wechsel bei Seitennavigation** — alle Pages eines Notebooks über denselben Room

### OPFS-Verschlüsselung

- Strokes: `JSON → AES-GCM encrypt(NotebookKey) → OPFS (notebooks/{nbId}/pages/{pageId}.bin)`
- Meta: `JSON → AES-GCM encrypt(MasterKey) → OPFS (meta.bin)`
- Fallback: Plain-JSON wird beim Lesen erkannt (Migration bestehender Daten)

### Notebook-Sharing

- Invite-Link: `#nb={notebookId}&k={base64(notebookKey)}&name={name}`
- Key ist nur im URL-Fragment — Browser sendet ihn nie an den Server
- Empfänger: NotebookKey wird installiert, Notebook erstellt, Full-Sync über P2P

### Relay-Sync (App v2)

- **Client:** `js/relay.js` — WebSocket Client, verbindet zu `wss://${location.host}`
- **Server:** `relay/server.js` — bestehender Server, speichert Base64-Strings via `node-put` (kein Object-Merge bei Strings)
- **Key-Schema:** `meta` → MasterKey-verschlüsselte Notebook-Struktur + NotebookKeys. `p:{nbId}/{pageId}` → NotebookKey-verschlüsselte Strokes.
- **Init-Flow:** `initRelay(roomKey)` → Join → `sync`-Response mit allen Blobs → `mergeRelayData()` entschlüsselt + `applyFullSync()` → `pushAllToRelay()` im Hintergrund
- **Laufend:** `saveAppMeta()` pusht Meta, `_flushSave()` pusht aktuelle Page, Deletes werden propagiert
- **Reconnect:** `handleActivityChange()` reconnectet WebSocket bei Tab-Fokus falls tot (Mobile-Browser schließen WS im Hintergrund)
- **Server sieht nur Ciphertext** — keine Entschlüsselung möglich ohne Passphrase

### Canvas / View Transform

- 3-Layer: bgCanvas (Hintergrund), staticCanvas (committed Strokes), activeCanvas (Live-Preview)
- **Bitmap-Cache** (`strokeCacheCanvas`): `redrawStrokes()` rendert in Cache, `compositeStrokes()` transformiert Cache für Pan/Zoom
- **compositeStrokes Delta:** `scaleRatio = viewScale / cacheViewScale`, `tx = (viewX - cacheViewX * scaleRatio) * DPR`
- **fitToContent:** Berechnet Bounding-Box aller Strokes, skaliert (max 1:1), zentriert mit 40px Padding
- **Aktuell kein inkrementelles Zeichnen** — Full-Redraw nach jedem Stroke (korrekt aber langsam bei >500 Strokes)

## Relay Server

### Lokal (`relay/`)

Node.js HTTPS + WSS Server für lokale Entwicklung:

```bash
cd relay && npm install && node server.js
```

- Serviert statische Files über HTTPS (mkcert-Zertifikat nötig)
- WebSocket Relay als Snapshot-Store (Graph-Nodes, kein Broadcast)
- **Daten in `relay/data.json`** — persistiert via debounced JSON-Write + Graceful Shutdown
- LAN-IP wird automatisch erkannt (nicht hardcoded)
- Message-Typen: `node-put` (speichern/mergen), `node-get` (einzelnen Node abrufen), `node-remove` (löschen) — kein Broadcast an andere Peers
- **Relay-Server Merge:** `node-put` merged statt überschreibt (`{ ...existing, ...msg.data }`). Verhindert, dass Metadata-Updates bestehende Strokes löschen.

#### mkcert Setup (einmalig)

```bash
mkcert -cert-file cert.pem -key-file key.pem localhost <LAN-IP>
```

LAN-IP ändert sich je nach WLAN — Zertifikat muss bei Netzwerkwechsel neu erstellt werden.
Für mobile Tests: `rootCA.pem` auf dem Gerät installieren (aus `mkcert -CAROOT`).

### Produktion (`relay-plesk/`)

Standalone WebSocket Relay auf Plesk (`wss://notes.mike.fm-media-staging.at`):

- **Kein HTTP-Server, kein Static-File-Serving** — nur `new WebSocket.Server({ port })`
- Passenger setzt `PORT` via `process.env.PORT`, Plesk macht TLS-Termination
- Gleiche Relay-Logik wie Dev-Server (rooms, node-put/get/remove, JSON-Persistenz)
- 30 Tage Room-TTL
- Client-URL in `js/relay.js`: `wss://notes.mike.fm-media-staging.at` (ohne Port)

#### Plesk WebSocket Setup

1. Node.js-App anlegen: Application Root = `relay-plesk`, Startup File = `server.js`
2. `npm install` über Plesk oder SSH
3. **Wichtig: nginx Proxy deaktivieren** — sonst fängt nginx den WebSocket-Upgrade ab und gibt 200 statt 101. Siehe: https://support.plesk.com/hc/en-us/articles/12377246437399
4. `WebSocket.Server({ port })` statt `WebSocket.Server({ server })` — Passenger kann keine WS-Upgrades auf dem HTTP-Server durchreichen
5. Client verbindet sich ohne Portangabe (`wss://domain/`), Plesk routet das zum Node-Prozess

## GenosDB — Genutzte Features

- **`password`-Option:** AES-256-GCM E2E-Verschlüsselung. Aktiviert via `gdb(roomKey, { rtc: true, password: roomKey })`.
- **Delta-Sync:** Eingebauter `deltaSync` mit OpLog + Hybrid Logical Clock. Automatischer Delta-Sync pro Instanz.
- **Graph-Datenbank:** Notebooks und Pages als Nodes in `rootDb`. Notebook→Page Beziehung über `notebookId` (kein `link()`).
- **Zwei Ebenen:** `rootDb` + `pageDb` — jede Seite hat eigenen Room und eigenes OPFS-File. Löst OPFS-Serialisierungsproblem und WebRTC Chunk-Limit.
- **Room-Channels:** `pageDb.room.channel("stroke-live")` für ephemere Live-Updates (kein `db.put()` nötig). Pattern aus GenosDB Whiteboard/Collab-Beispielen.
- **`saveDelay`-Option:** Auf 0 gesetzt (sofortiger OPFS-Write). War vorher 1000ms, was bei schnellem Seitenwechsel zu Datenverlust führte (pageDb wurde geschlossen bevor der Write fertig war).

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
- **Init-Lücke (Session 2026-03-25):** P2P-Nodes die nach Phase 1 aber vor `dbInitialized=true` ankamen gingen verloren → Fix: Final-Merge von initNodes vor dbInitialized
- **Cross-Notebook Stroke-Leak:** `createNotebook()` und `createTestNotebook()` riefen kein `openPageDb()` auf → strokeChannel/pageDb zeigten noch auf alte Seite → Fix: openPageDb bei jeder Notebook-Erstellung
- **Relay überschrieb neuere Daten:** Phase 2 Relay-Merge schrieb ALLE Nodes (inkl. stale Strokes) blind in rootDb → Fix: nur neue Nodes (die lokal fehlen) in rootDb, Strokes aus Relay-Daten strippen
- **Seiten-Verwechslung bei schnellem Blättern:** Späte Events vom alten pageDb schrieben Strokes der vorherigen Seite in die neue → Fix: Stale-Guard (`pageDb !== thisDb`) in pageDb.map und strokeChannel Callbacks
- **OPFS-Write bei Seitenwechsel nicht fertig:** `saveDelay:1000` + sofortiges `room.leave()` → OPFS-Write nie fertig → Fix: saveDelay auf 0
- **Notebook-Löschung nicht synchronisiert:** Pages wurden nicht vom Relay gelöscht, rootDb.map Handler löschte keine Pages bei Notebook-Removal → Fix: beides ergänzt
- **NotebookKey-Mismatch bei Relay-Sync (Session 2026-03-27):** Jedes Gerät generierte eigene NotebookKeys. Relay-Daten mit Android's Key verschlüsselt → Laptop konnte nicht entschlüsseln (anderer Key) → Strokes lautlos `[]`. Fix: NotebookKeys in verschlüsselter Meta einbetten, `installNotebookKeys()` bei loadAppMeta + mergeRelayData

### Was nicht funktioniert hat
- **Evolu (echtes Paket):** Braucht Build-Step (WASM + Web Workers). Kein CDN-Import möglich wegen `new URL("file", import.meta.url)` Pattern.
- **Performance-Optimierung via Stroke-Caching:** Caching von smoothed Points in `_pts`/`_poly` + inkrementelles Canvas-Update führte zu visuellen Regressions. Reverted.
- **OPFS als persistenterer Speicher:** OPFS und IndexedDB werden bei "Cookies & Websitedaten löschen" identisch gelöscht. Kein Persistenz-Vorteil.
- **Zwei Tabs mit verschiedenen Room-Keys:** GenosDB/OPFS teilt sich Ressourcen pro Origin → Konflikte.
- **Node-per-Stroke Modell:** Jeder Stroke als eigener GenosDB-Node. Full-State-Sync bei >500 Nodes überschreitet WebRTC Chunk-Limit. Relay-Broadcast-Sturm bei vielen Nodes. Umgestellt auf Node-per-Page.
- **Firefox Stable + OPFS:** `GetDirectory` wirft `SecurityError`. GenosDB kann nicht initialisiert werden. App fällt auf Relay-only zurück.
- **Einzelne GenosDB-Instanz für alles:** OPFS-Serialisierung des gesamten Graphs blockiert Main Thread bei vielen Strokes. Gelöst durch rootDb + pageDb Split.
- **Relay als Live-Sync-Kanal:** Broadcast jedes Stroke-Events an alle Peers verursachte Event-Sturm. Relay ist jetzt nur Snapshot-Store (kein Broadcast).
- **saveDelay > 0 bei pageDb:** Mit `saveDelay: 1000` wurde `pageDb.room.leave()` aufgerufen bevor der OPFS-Write fertig war → Strokes gingen bei schnellem Seitenwechsel verloren. Fix: `saveDelay: 0`.
- **Relay-Daten blind in metaDb/rootDb schreiben:** Relay hat oft ältere Snapshots als lokale OPFS-Daten. Blindes `rootDb.put()` für alle Relay-Nodes überschrieb neuere lokale Daten und propagierte alten Stand an Peers. Fix: Nur neue Nodes (die lokal fehlen) in rootDb, Strokes nie in rootDb.
- **Snapshot-Push mit leeren Strokes:** Beim Init-Snapshot-Push hatten nur die aktuelle Seite Strokes im Memory, alle anderen `strokes: []`. Das überschrieb gültige Relay-Daten. Fix: Strokes nur für aktuelle Seite pushen, Relay-Server merged statt überschreibt.

### Erkenntnisse Session 2026-03-26/27 (App v2 / experiment/yjs-sync)

- **GenosDB map() feuert nach FULL SYNC nicht:** Der interne `requestAnimationFrame`-Debounce in `t()` verschluckt Benachrichtigungen. Workaround war Poll via `pageDb.get()` — letztlich Grund für den Umstieg auf Trystero.
- **GenosDB Node-per-Page mit Array-Strokes:** CRDT arbeitet auf Node-Ebene, nicht Array-Ebene. Zwei Peers die `put({strokes:[...]})` aufrufen → Last-Writer-Wins für gesamtes Array. Kein per-Stroke Merge möglich.
- **Yjs wurde evaluiert aber nicht verwendet:** CDN-Import funktioniert, aber Yjs + GenosDB wäre doppeltes P2P. Yjs allein hätte GenosDB komplett ersetzt — zu großer Umbau für den Gewinn. Stattdessen: eigene Sync-Logik mit Trystero.
- **Trystero Room bei Tab-Wechsel nicht zerstören:** `room.leave()` + `joinRoom()` bei jedem `visibilitychange` zerstörte WebRTC-Verbindungen. Nostr-Signaling braucht 5-15s zum Reconnect → Sync-Lücken. Fix: Bestehende Verbindung behalten, nur Full-Sync senden.
- **Android Chrome `visibilitychange`/`focus` unzuverlässig:** Feuert nicht immer beim App-Wechsel. Workaround: Erster `pointerdown` nach >5s Inaktivität triggert Full-Sync.
- **Inkrementelles Stroke-Rendering + DPR:** `staticCtx.save()/translate()/scale()/drawStroke()/restore()` führte zu Versatz bei unterschiedlichen Container-Größen (DevTools, Sidebar). Ursache: DPR-Transform blieb in `save/restore` erhalten, Delta-Berechnung stimmte nicht. Aktuell: Full-Redraw nach jedem Stroke (korrekt, aber langsam). Inkrementell kann später mit explizitem `setTransform(DPR,...)` statt `save/restore` wieder eingebaut werden.
- **Duplikat-Notebooks nach Cache-Clear:** Jeder Browser erstellt ein Default-Notebook. Nach Full-Sync existieren Duplikate mit gleichem Namen. Fix: Nach Full-Sync Duplikate by Name deduplizieren (ältestes behalten, Strokes mergen).

### Erkenntnisse Session 2026-03-27b (Relay v2 + Features)

- **NotebookKeys müssen in Meta reisen:** Ohne Key-Sharing über die verschlüsselte Meta kann kein Gerät die Relay-Daten eines anderen entschlüsseln. P2P-Sync war davon nicht betroffen (Strokes werden dort unverschlüsselt über den verschlüsselten WebRTC-Kanal gesendet), aber Relay speichert die OPFS-verschlüsselten Blobs → braucht identische Keys.
- **Relay nutzt bestehenden Server unverändert:** `node-put` mit Base64-String (statt Object) löst keinen Object-Merge auf dem Server aus → Ciphertext wird 1:1 gespeichert. Kein neues Server-Protokoll nötig.
- **Mobile WebSocket-Verbindungen sterben im Hintergrund:** Browser schließen WebSockets aggressiv wenn die App nicht aktiv ist. `relayPut()` in `_flushSave()` geht dann ins Leere. Fix: `handleActivityChange()` reconnectet Relay bei Tab-Fokus und pusht alle Pages erneut.
- **Relay-Merge via applyFullSync():** Statt eigene Merge-Logik zu schreiben, werden Relay-Daten in ein Full-Sync-Payload-Format umgewandelt und durch die bestehende `applyFullSync()`-Funktion gemerged. Weniger Code, gleiche Merge-Semantik.

### Erkenntnisse Session 2026-04-02 (Plesk Relay + Cleanup)

- **Plesk/Passenger kann keine WebSocket-Upgrades auf `http.createServer()`:** `WebSocket.Server({ server })` funktioniert nicht — Passenger fängt den HTTP-Request ab und gibt 200 zurück statt den Upgrade durchzuleiten. Fix: `WebSocket.Server({ port })` (standalone, wie die funktionierende Listapp).
- **nginx Proxy in Plesk deaktivieren für WebSockets:** Mit aktiviertem nginx Proxy leitet Plesk den WebSocket-Upgrade nicht korrekt weiter. Muss in den Domain-Einstellungen deaktiviert werden. Ref: https://support.plesk.com/hc/en-us/articles/12377246437399
- **Client verbindet sich ohne Portangabe:** `wss://domain/` (Port 443) — Plesk routet das intern zum Node-Prozess. Kein expliziter Port im Client nötig.
- **Öffentliche Nostr-Relays sind unzuverlässig:** `relay.nostr.band` war komplett down. Relay-Liste muss regelmäßig geprüft werden. Trystero braucht nur einen funktionierenden Relay für Signaling.
- **Firefox `network.websocket.enabled`:** Kann durch Updates/Profil-Reset auf `false` gesetzt werden — alle WebSocket-Verbindungen schlagen fehl (Nostr-Signaling + Relay).

### Service Worker
- `sw.js` nutzt **Network-first für HTML** (Änderungen sofort sichtbar) und Stale-while-revalidate für Libs
- Vorher Cache-first → Firefox zeigte alte Versionen nach Code-Änderungen
- CDN-Requests (jsdelivr, esm.sh) werden per Stale-while-revalidate gecacht (Offline-Support für Trystero)

## Commit Convention

Imperative, lowercase, concise. Examples from history: "Try fix some sync cases", "Add pen option", "Update presentationpage".
