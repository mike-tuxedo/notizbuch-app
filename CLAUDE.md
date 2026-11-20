# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Notizbuch** is an offline-first Progressive Web App for handwritten notes with end-to-end encrypted P2P synchronization via WebRTC. No build system — all files are served statically.

- **Language:** German (UI, comments, commit messages)
- **Rendering:** HTML5 Canvas (multi-layer)
- **UI:** hell/dunkel über Tokens (Vorlage: Klickdummy in `artifacts/redesign/`)
- **Sync:** Trystero P2P (live) + WebSocket Relay (offline backup)
- **Storage:** OPFS (with IndexedDB fallback)
- **Encryption:** AES-GCM 256 (Web Crypto API)

## Development

No build step. Serve the root directory with any static HTTP server. The dev server in `dev-server/` does this and adds the relay backend.

```bash
cd dev-server && npm install && node server.js
# → https://localhost:4444/app.html
```

App at `./app.html`, landing page at `./index.html`.

**Service Worker:** Bump `CACHE_NAME` in `sw.js` after changes to static assets.

## File Structure

```
app.html              — UI shell (CSS-Tokens hell/dunkel + HTML, 3-Layer Canvas, Dialoge; einziges JS: Theme-Inline-Skript)
index.html            — Marketing landing page (standalone)
sw.js                 — Service Worker (network-first HTML, stale-while-revalidate libs)
manifest.json         — PWA manifest

js/
├── app.js            — State, Init, UI (Popover, Dialoge, Toasts, Seitenübersicht), Input, Navigation, Sync-Integration
├── canvas.js         — Drawing Engine (Catmull-Rom smoothing, polygon fill), Formen (Vektor, Umriss, SVG), Abbildung/Grenzen/Treffertest für Objekte
├── storage.js        — OPFS + IndexedDB Fallback
├── encryption.js     — AES-GCM 256 wrapper (generate/import/export/encrypt/decrypt)
├── p2p-sync.js       — Trystero multi-room P2P (Nostr signaling)
├── relay.js          — WebSocket relay client (backup snapshots)
└── share.js          — Sicherungsdatei packen/öffnen (`packBackup`/`unpackBackup`, Passphrase → PBKDF2 → AES-GCM)

libs/                 — Vendored third-party libs (iro.js, qrcode.js)
dev-server/           — Local dev server (HTTPS + WSS + static files, mkcert); tests/ = Playwright-Abnahmetests
artifacts/redesign/   — Klickdummy des Redesigns (Vorlage für Tokens, Layout, Texte)
backup-relay/         — Production relay (standalone WebSocket on Plesk)
```

## Sync Architecture

Three layers — **P2P is a fast path, Relay adds live sync and offline backup**:

### 1. Nostr Relays (Signaling only)

Public Nostr relays are used for **Trystero peer discovery only**. We pass no relay list: Trystero (pinned to 0.24.0) picks from its built-in defaults, deterministically per `appId`, so all devices use the same relays.

We do NOT host our own Nostr relay. A custom list would go in `relayConfig: { urls: [...] }` (not `relayUrls`, which 0.24 ignores). Verify each URL first — many public relays reject events.

### 2. WebRTC P2P (Trystero, Multi-Room)

**Direct peer-to-peer as a fast path** — strokes, undo, page events.

- **Main Room** (`masterKeyHash`): All own devices. Full app-state sync.
- **Shared Rooms** (one per shared notebook, `notebookHash`): Sharer + recipient(s) of a specific notebook.

`p2p-sync.js` exposes `initP2P` (main), `joinSharedRoom`/`leaveSharedRoom` (per notebook), `send` (target-room aware), `sendToAll`. `p2pSendForNotebook(action, data)` in app.js sends to main + matching shared room.

### TURN / ICE-Einstellungen (device-lokal)

P2P-Verbindungen nutzen standardmäßig Trysteros eingebautes STUN. Hinter strengem NAT braucht es oft ein TURN-Relay. Der Nutzer kann unter Einstellungen → „Verbindung“ einen TURN-Server (`turn:…`/`turns:…` mit Benutzername/Passwort) oder einen HTTPS-Endpunkt eintragen, der kurzlebige `{"iceServers":[…]}`-Zugangsdaten liefert. Die Einstellung wird gerätelokal in IndexedDB (`notizbuch-settings`, Schlüssel `device:iceSettings`) gespeichert — sie wird **nicht** synchronisiert, nicht exportiert und nicht in Share-Links aufgenommen. Eine geänderte ICE-Einstellung lädt die App beim Speichern neu.

Im selben Abschnitt lässt sich die **Relay-Adresse** überschreiben (`device:relayUrl`, ebenfalls gerätelokal, nur `wss://`/`ws://`). Leer = Standard aus `defaultRelayUrl()` in `js/relay.js` (auf localhost das Relay des Dev-Servers). Beim Speichern baut `rebuildRelayConnections()` Live-Kanäle und Relay-Verbindung ohne Neuladen neu auf.

**Actions:** `stroke`, `undo`, `redo`, `edit`, `clear`, `full-sync`, `nb-created`, `nb-deleted`, `nb-renamed`, `page-created`, `page-deleted`, `page-bg`

**Cross-user notebook ID mapping:** Sharer and recipient have different local `notebookId` for the same notebook. `_resolveNbId(eventNbId, roomId)` maps incoming events from a shared room to the local notebookId via `notebookHash`.

### 3. WebSocket Relay (Live sync + backup snapshot store)

`wss://notes.mike.fm-media-staging.at` (Plesk-hosted, code in `backup-relay/`).

**Purpose:**
1. **Live sync:** Jeder verbundene Client öffnet einen eigenen dauerhaften Kanal pro Room (`join` mit `nosync:true`). Der Server leitet eingehende `event`-Nachrichten (Base64-Ciphertext) sofort an alle anderen Clients im selben Room weiter — ohne Speichern. Damit funktioniert Live-Sync auch ohne WebRTC/P2P.
2. **Backup blob storage for offline peers** — when a peer comes online later, they fetch missed updates from here.

- Server sees only ciphertext (Base64 strings)
- 30-day room TTL
- Message types: `join` (mit `nosync:true` für Live-Kanäle), `event` (Live-Weiterleitung), `node-put`, `node-get`, `node-remove`
- Alte Server, die `nosync` nicht kennen, antworten mit `sync` statt `joined` → Live wird als "nicht unterstützt" angezeigt, der Blob-Backup-Weg bleibt aber bestehen.

**Two room types** (server doesn't know the difference):
- `masterKeyHash` → own devices' live channel + backup
- `notebookHash` → per-shared-notebook live channel + backup (parallel to P2P shared room)

**Push patterns:**
- Main relay: `_flushSave()` debounced 1s after stroke → `relayPut(p:{nbId}/{pageId}, ciphertext)`
- Shared room: debounced 3s, **fetch-merge-push** (fetch room first, merge event union by `event.id`, push merged event log — prevents overwriting peer's data)
- Live events: `syncSend(action, data)` verschlüsselt jede Broadcast-Nachricht zusätzlich mit dem Room-Key und sendet sie über `sendLiveEvent`

## Page Event-Log (single source of truth)

Since version `v2` each page stores an encrypted event-log (`page.events`) instead of a raw stroke array.
`page.strokes` is only a **materialized view** computed by `materializePage()` / `refreshPageMaterializedState()`.

- Event format: `{ id, type, createdAt, deviceId, seq, ... }`
- Types:
  - `stroke` (carries `stroke`) — ein Objekt: Stiftstrich, Radierer-Strich oder Form
  - `undo` mit `targetStrokeId` — blendet ein Objekt aus; mit `reason: 'delete'` ist es ein Löschen über die Auswahl
  - `undo` mit `targetEventId` — hebt ein `edit`-Event auf
  - `redo` mit `targetEventId` — hebt ein `undo`-Event auf (beide Arten)
  - `edit` mit `targetStrokeId` + `patch` — ändert ein Objekt (siehe „Objekte ändern“)
- Alles ist additiv: Versionen vor v47 behalten unbekannte Typen/Felder im Log und reichen sie weiter, werten sie aber nicht aus.
- Storage blob: `{ version: 2, events: [...] }` (legacy stroke arrays are converted to `legacy:` events on read)
- Merging is always a **union by `event.id`**. Remote data is never replaced; `mergePageEvents()` adds only unknown events.
- Duplicate strokes are prevented at event-merge time (same `stroke.id`) and defensively in `materializePage()`.
- **Schutz vor unvollständigem Schreiben:** Beim Start liegen nur Meta + aktuelle Seite im Speicher. `serializePageData()` mischt deshalb zuerst den Plattenstand ein (`loadPage`, einmal pro Seitenobjekt, `_pagesMergedFromDisk`), bevor eine Seite geschrieben wird — sonst überschreibt ein Sync-Event oder ein `full-sync` (`applyFullSync` speichert alle Seiten) die Datei einer nicht geladenen Seite mit einem unvollständigen Event-Log.
- `undo()` appends an `undo` event with the `targetStrokeId`. Undo events work regardless of arrival order because `materializePage()` applies all undos after rendering strokes.
- `redo()` appends a `redo` event; `materializePage()` ignoriert jedes `undo`, dessen ID Ziel eines `redo` ist — ebenfalls unabhängig von der Reihenfolge.
- `clearedAt` still hides stroke events with `createdAt <= clearedAt`; undo events are not affected by the clearedAt check.

## Formen (stroke mit tool 'shape')

Eine Form ist ein gewöhnliches `stroke`-Event — Vereinigung, `clearedAt`, Undo/Redo, Relay und P2P laufen unverändert.

```
stroke: { id, createdAt, tool: 'shape', shape: { type: 'rect'|'ellipse'|'line'|'arrow', x1, y1, x2, y2 },
          color, size, fill: '#rrggbb'|null, points: [...] }
```

- `shape` in Weltkoordinaten, auf 0.1 gerundet (`roundShape`). `fill` nur für Rechteck/Ellipse, sonst `null`.
- `points` ist der **Umriss als Punktfolge** (`shapeOutlinePoints`): Versionen vor v47 kennen `shape` nicht und zeichnen ihn als Stiftstrich. Gleichmäßig dichte Punkte (keine doppelten Eckpunkte — die erzeugen im Catmull-Rom Schleifen), Rechteck beginnt mitten auf der Oberkante, Ellipse läuft zwei Punkte über den Anfang hinaus. Im alten Renderer sieht das fast wie die Vektorform aus (Ecken minimal rund, keine Füllung).
- `drawStrokeToCanvas` zeichnet Formen als Vektor (`drawShapeToCanvas`) — damit in Hauptansicht, Aufzieh-Vorschau, Vorschaubildern, PNG und Grenzen. SVG-Export: `shapeToSvg` (`<rect>`, `<ellipse>`, `<line>`, Pfeil als `<path>`).
- Eine spätere Füllfläche (Füllwerkzeug) soll genauso eine weitere Objektart sein: `stroke`-Event mit eigenem `tool`, `points` als Ersatzdarstellung; `edit`, Löschen und Auswahl gelten dann ohne Weiteres.

## Objekte ändern (edit-Events)

`{ id, type: 'edit', createdAt, deviceId, seq, targetStrokeId, patch }` — `patch` enthält nur geänderte Felder:

- `transform: [sx, sy, tx, ty]` — **absolute** Abbildung der *ursprünglichen* Geometrie (`x' = sx·x + tx`), kein Drehen. `sx`/`sy` auf 1e-6, `tx`/`ty` auf 0.1 gerundet. Gilt auch für Stiftstriche (Punkte werden abgebildet, Strichstärke bleibt).
- `color`, `fill` (Farbe oder `null`), `size`.
- `materializePageDetailed()` wendet pro Objekt und **pro Feld** den letzten nicht aufgehobenen edit an (Reihenfolge `sortPageEvents`: createdAt, deviceId, seq) — letzter gewinnt, unabhängig von der Ankunft. Das Ursprungs-Event wird nie verändert. edits für unbekannte/ausgeblendete Ziele bleiben wirkungslos im Log.
- `page.strokes` / `materializePage()` liefern das **fertige Objekt** (`applyStrokePatch` → `transformStroke`); Renderer, Grenzen, Vorschau, Export und Sicherung wissen nichts von edits.
- Live-Weg: Sync-Aktion `edit` (`onEdit`, wird wie `stroke`/`undo`/`redo` zwischen Haupt- und Shared-Room weitergereicht). Beim Ziehen entsteht **ein** Event beim Loslassen (`commitEdit`), vorher nur lokale Vorschau (`_selPreview`).
- Löschen = `undo`-Event mit `targetStrokeId` und `reason: 'delete'`; Duplizieren = neues `stroke`-Event mit der fertigen Geometrie, versetzt um 16 Bildschirm-Pixel.

## Seiten-Meta (clearedAt / deletedAt / restoredAt)

Seiten-Meta (`pageMeta()`: `id, background, order, createdAt, clearedAt, deletedAt, restoredAt`) steht in `meta.bin`, im Relay-`meta`, im Shared-Room-`meta` und in `full-sync`-Nachrichten (`sendNotebookMeta`). Gemischt wird nur in `applyPageMeta()`: alle drei Zeitfelder per **Maximum**.

- Eine Seite ist gelöscht genau dann, wenn `deletedAt > (restoredAt || 0)` (`isPageDeleted()`). `deletedAt` wird nie zurückgesetzt — das ginge beim Mischen verloren.
- `restorePage(pageId)` setzt `restoredAt = max(now, deletedAt + 1)`; erneutes Löschen setzt `deletedAt` über `restoredAt`.
- `restoredAt` ist additiv: ältere Versionen ignorieren das Feld (bei ihnen bleibt eine wiederhergestellte Seite gelöscht, sie machen aber nichts kaputt).
- **Verzögertes Festschreiben:** „Seite leeren“ / „Seite löschen“ wirken zuerst nur lokal (`startPendingPageOp`, `_pendingPageOp`) und zeigen einen Hinweis mit „Rückgängig“. Erst wenn er abläuft — oder früher bei Seiten-/Notizbuchwechsel, beim Verstecken der App, beim nächsten eigenen Strich — schreibt `commitPendingPageOp()` den Wert in die Seite, speichert und sendet. Merkzettel `localStorage notizbuch:pendingPageOp` holt das nach einem Neuladen in der Frist nach (`recoverPendingPageOp`).
- Gelöschte Seiten zählen in Navigation und Zähler nicht mit (`visiblePages()`); sie stehen nur in der Seitenübersicht. Nach dem Löschen springt die Ansicht auf die Nachbarseite; war es die letzte, entsteht eine Ersatzseite mit der ID `auto-{deletedAt}` (deterministisch, damit zwei Geräte dieselbe anlegen — `appendReplacementPage`, `ensureVisiblePage`).
- Wird die aktuelle Seite woanders gelöscht, wählt `ensureCurrentPageId()` die Nachbarseite und `reconcileShownPage()` (aus `renderUI()`) zieht die Zeichenfläche nach.

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

**fitToContent:** Pixel-based — renders strokes (incl. eraser) to temp canvas, scans non-transparent pixels for bounding box. Correctly excludes erased areas. Called only on page switch, notebook switch, init, „Alles“-Knopf (Zoom-Pille `− [Alles] +`, Taste 0) — never on sync events.

**Hinweis „Weiterer Inhalt“:** Die Inhalts-Grenzen werden gecacht (`_contentBounds`, neu nur bei geänderten Strichen, entprellt) und bei Pan/Zoom gegen den Ausschnitt verglichen (`updateContentHint`). Die Ansicht wird nie automatisch verschoben.

**Papier** ist in beiden Themes weiß (`--paper`), Linien `--paper-line`. Weiß gibt es nicht als Stiftfarbe.

**Wichtig für Tests:** `document.querySelectorAll('canvas')[2]` ist die aktive Zeichenfläche. Weitere Canvases (Vorschaubilder, QR) stehen im DOM dahinter. Auf der aktiven Fläche liegt auch der Auswahlrahmen (im Werkzeug „Auswahl“ wird dort nicht gezeichnet); die Leiste `#selbar` steht als `<div>` hinter den drei Flächen im Container.

**Radierer und Formen:** Radierer-Striche wirken pixelweise in Zeitreihenfolge auf alles davor Gezeichnete, auch auf Formen. Sie gehören nicht zum Objekt — siehe Known Issues.

## Input

- **Pen** (`pointerType === 'pen'`) always draws regardless of tool.
- **Pen-only mode** (Einstellungen → Allgemein → „Nur Stift“): completely ignores touch in pen/eraser tools.
- **Touch** in pen/eraser tool: 1 finger draws. (`penOnlyMode` blocks this.)
- **Hand ist ein Schalter, kein Werkzeug** (`#btn-hand`, `toggleHand()`, Taste H): an = 1 Finger/Maus bewegt, 2 Finger zoomen; aus = zurück zum zuletzt benutzten Werkzeug (`state.lastDrawTool`). Ein Werkzeug wählen schaltet die Hand aus. Leertaste halten = vorübergehend bewegen.
- **Formen** (`state.tool === 'shape'`, Form in `state.shapeType`, gerätelokal gemerkt): aufziehen mit Stift/Maus/Finger nach denselben Regeln wie der Stift (Nur-Stift-Modus sperrt den Finger). Umschalt hält Quadrat/Kreis bzw. rastet Linie/Pfeil auf 45°. Unter 5 Bildschirm-Pixeln wird nichts angelegt. Farbe und Stärke kommen von den Knöpfen der Leiste.
- **Auswahl** (`state.tool === 'select'`): siehe Abschnitt „Auswahl“.
- **Tasten:** P Stift, E Radierer, S Formen, V Auswahl, H Hand, 0 alles zeigen, Strg/Cmd+Z Rückgängig, Strg/Cmd+Umschalt+Z bzw. Strg/Cmd+Y Wiederholen, Esc schließt Dialog → Popover → Auswahl → Schublade. Nicht in Textfeldern und nicht bei offenem Dialog.
- **No swipe page navigation** — explicit gestures removed.
- DPR capped at 2.

## Hauptansicht

- Leiste: Notizbuch-Titel (öffnet die Schublade), Hand-Schalter, Stift/Radierer/Formen/Auswahl (der Formen-Knopf zeigt die gewählte Form und öffnet `#pop-shapes`), Farbe, Strichstärke (je ein eigenes Popover), Undo/Redo, Sync-Status, Seiten-Menü „⋯“ (Papierart, Teilen, Export PNG/SVG, Vollbild, Seite leeren/löschen).
- Popover: `data-toggle="id"` am Auslöser, `data-pop` am Popover (`togglePopover`/`closePopovers`).
- Seiten-Pille `‹ n / m › +`: „›“ legt keine Seite an, dafür „+“. Der Zähler (`#btn-page-overview`) öffnet die Seitenübersicht.
- Breiten: ab 1180 px Werkzeuge mit Beschriftung, unter 760 px Werkzeugreihe unten. Bedienflächen mindestens 44 px.

## Auswahl

Werkzeug „Auswahl“ (V). Rein lokal, nicht synchronisiert; immer genau ein Objekt (keine Mehrfachauswahl). Code: Abschnitt „Auswahl“ in `js/app.js`, Geometrie in `js/canvas.js`.

- **Treffer** (`hitTestObjects` → `hitTestStroke`): oberstes sichtbares Objekt; Stiftstrich und Kontur über den Abstand zur Linie, gefüllte Formen auch über die Fläche; Radierer-Striche nie. Toleranz in Bildschirm-Pixeln (Maus 8, Touch 20), unabhängig vom Zoom.
- **Rahmen** mit 8 Griffen in Petrol `#0b7285` (beide Themes) auf `activeCanvas` (`drawSelectionOverlay`), folgt Pan/Zoom. Griff-Trefferfläche: Maus 20 px, Touch 44 px; nach innen höchstens ein Viertel des Rahmens, damit kleine Objekte verschiebbar bleiben.
- **Ziehen** am Objekt bzw. im Rahmen verschiebt, an einem Griff ändert die Größe (gegenüberliegende Seite fest, kein Spiegeln — beim Überziehen bleibt die Mindestgröße von 8 Bildschirm-Pixeln). Tipp in den Rahmen ohne Ziehen wählt das Objekt darunter bzw. hebt auf.
- **Leiste** `#selbar` am Objekt: Farbe, Füllung (nur Rechteck/Ellipse: „Keine Füllung“ + Palette), Duplizieren, Löschen (Hinweis „Objekt gelöscht“ mit „Rückgängig“).
- **Tasten:** Entf/Rücktaste löscht, Esc hebt auf, Pfeiltasten schieben um 1 bzw. mit Umschalt 10 Bildschirm-Pixel; Tastendrücke innerhalb von 600 ms werden zu einem edit (`nudgeSelection`/`flushNudge`).
- **Verschwindet** bei Seiten-/Notizbuchwechsel, Wechsel auf Stift/Radierer/Formen, Leeren der Seite und wenn das Objekt (auch durch ein anderes Gerät) verschwindet — geprüft bei jedem Neuzeichnen (`displayStrokes`). Der Hand-Schalter lässt sie stehen. Ändert ein anderes Gerät das Objekt, folgt der Rahmen; während des eigenen Ziehens gilt die lokale Vorschau.

## Seitenübersicht

`#pages-modal` (`openPageOverview`, `refreshPageOverview`): Raster mit Vorschaubild je Seite, aktuelle markiert, Kachel „Neue Seite“; darunter „Gelöschte Seiten“ mit „Wiederherstellen“. Tipp auf eine Kachel wechselt die Seite und schließt.

- Vorschauen entstehen träge: `IntersectionObserver` reiht sichtbare Kacheln ein, `runThumbQueue()` rendert eine nach der anderen mit Pausen.
- `renderPageThumb()` nutzt `drawBackground`/`drawStrokeToCanvas` aus `canvas.js` und `computeStrokeBounds(strokes, maxDim)`; eingepasst wie `fitToContent`, leere Seite = Standardausschnitt.
- Die Seitendaten werden in eine **Kopie** geladen (`loadPage` auf ein Hilfsobjekt) — State, Ansicht und `strokeCacheCanvas` der Hauptansicht bleiben unberührt.
- Cache `_thumbCache` pro Seite; neu gerendert wird nur bei geänderter `thumbSignature()` (Anzahl Events, `clearedAt`, Papierart).

## Hinweise (Toasts) und Dialoge

- `showToast(text, { action, key, fehler, onExpire, dauer })` → `#toasts` (aria-live). Gleicher `key` ersetzt den Vorgänger, höchstens 3 gestapelt.
- Keine nativen `alert/confirm/prompt`. Rückfrage (`confirmDialog`) nur vor Unwiderruflichem (Notizbuch löschen, Schlüssel ersetzen); Eingaben über `promptDialog`.
- Leeren/Löschen einer Seite: Hinweis mit „Rückgängig“ statt Rückfrage (siehe Seiten-Meta). Weitere Hinweise: „Seite N angelegt“, „Link kopiert“/„Schlüssel kopiert“, „Seite wiederhergestellt“.

## Themes und Einstellungen

- Tokens in `app.html` (`:root` / `[data-theme="dark"]`), Tabelle in `artifacts/redesign/README.md`. Wahl System/Hell/Dunkel unter Einstellungen → Allgemein (`setTheme`), gerätelokal in IndexedDB (`device:theme`), Kopie in `localStorage notizbuch:theme` für das Inline-Skript (kein Aufblitzen).
- Einstellungen (`#settings-modal`, `openSettings(section)`): Allgemein (Theme, Nur Stift), Geräte (Gerät koppeln per Link/QR/Scan), Verbindung (TURN, Relay-Adresse, Sync-Diagnose), Daten & Schlüssel (Schlüssel sichern, Sicherung `.enc` exportieren/importieren — siehe „Sicherung“).
- Teilen (`#share-modal`, `openShareModal(tab)`): Reiter Einladen / Beitreten.

## Sicherung (Export / Import)

Einstellungen → Daten & Schlüssel; Import zusätzlich im Erststart-Dialog („Sicherung einspielen“, `#btn-restore-backup`). Code: Abschnitt „Sicherung (.enc)“ in `js/app.js`, Verschlüsselung in `js/share.js`.

- **Datei** `notizbuch-backup.enc`: `[16 Bytes Salt][12 Bytes IV][AES-GCM-256]`, Schlüssel per PBKDF2-SHA-256 mit 600 000 Iterationen aus der Passphrase (`deriveKeyFromPassphrase`). Inhalt JSON, Typ `notizbuch-backup-v3`: `masterKey`, `notebookKeys`, `sharedNotebooks` (IDs), `notebooks[{id, name, pages[{…pageMeta, events}]}]` — das **vollständige Event-Log** jeder Seite, nicht nur materialisierte Striche. Gerätelokale Einstellungen stehen nicht darin.
- **Export** (`exportBackup`): schreibt vorgemerktes Leeren/Löschen fest, fragt im Dialog `#backup-export-modal` Passphrase + Wiederholung ab (mindestens 8 Zeichen), lädt jede Seite von der Platte (`buildBackupPayload`).
- **Import** (`importBackup` → `importBackupFile`), drei Fälle:
  - Gerät ohne Schlüssel → `installBackup`: Schlüssel, NotebookKeys, Notizbücher und Seiten schreiben, neu laden.
  - derselbe MasterKey → `mergeBackup`: nichts ersetzen; `applyFullSync` (Meta über `applyPageMeta`, Events über `mergePageEvents`), danach `distributeNotebooks` (Relay-Blobs, `full-sync` je Seite, Shared-Rooms).
  - anderer MasterKey → `confirmDialog`, dann `installBackup`: geht offline (P2P, Live-Kanäle, Relay — nichts aus der Sicherung darf im Room des alten Schlüssels landen), `clearAll()`, entfernt `notizbuch:nbKey:*`, `notizbuch:sharedNotebooks`, den Merkzettel und die Navigations-Einstellungen des alten Schlüssels, schreibt den Inhalt, lädt neu. Währenddessen sperrt `_dataSwapRunning` Autosave, `saveAppMeta`, `applyFullSync` und `resync`.
  - Nach dem Neuladen verteilt `init()` einmalig alles (`sessionStorage notizbuch:nachEinspielen`).
- **Alte Formate:** `notizbuch-backup-v2` (mit dem MasterKey verschlüsselt, materialisierte Striche) wird zuerst mit dem Geräteschlüssel probiert (`openV2Backup`) und ohne Passphrase-Abfrage gemischt; Striche werden zu Events `import:{strokeId}`. Das alte Passphrase-Schlüsselbündel (`{masterKey, notebookKeys}` ohne Typ) installiert weiter nur die Schlüssel.
- Passphrase und Schlüssel nie loggen, nicht in Hinweise, nicht in localStorage/sessionStorage; die Felder werden beim Schließen geleert.
- Wie jeder Sync übernimmt das Mischen Name, Reihenfolge und Papierart aus der Datei (`mergeNotebookMetaIntoState`) — eine alte Sicherung kann eine spätere Umbenennung zurückdrehen.

## Notebook Management

- Notebook list is a drawer (overlay) behind the title button; footer = sync status + gear (settings)
- **„⋯“ menu per notebook** (same for mouse and touch): rename, share, delete (`#nb-menu`)
- **Inline rename**: input replaces the row in the list; delete asks via `confirmDialog()`
- Names are untrusted (invite links, `name=`): always set via `textContent`, never `innerHTML`
- **Dialogs**: `openDialog(id)` / `closeDialog(id)` handle focus, Esc and focus return; settings (`openSettings(section)`) and share (`openShareModal(tab)`) are the only two places

## Undo / Redo

`undo()` nimmt die **letzte Aktion der Seite** zurück (`lastPageAction`). Aktionen sind:

| Aktion | wirksam, wenn | Zeit | Rückgängig erzeugt |
|---|---|---|---|
| Objekt gezeichnet (`stroke`) | Objekt sichtbar | `createdAt` des Strichs | `undo` mit `targetStrokeId` |
| Objekt geändert (`edit`) | nicht aufgehoben, Ziel sichtbar, Patch gültig | `createdAt` des Events | `undo` mit `targetEventId` |
| Objekt gelöscht (`undo` mit `reason: 'delete'`) | nicht aufgehoben, Objekt existiert (nach `clearedAt`), kein zweites Undo auf demselben Objekt | `createdAt` des Events | `redo` mit `targetEventId` |

Die späteste Zeit gewinnt; bei Gleichstand edit/Löschen vor Strich, sonst deviceId, seq. Ein gewöhnliches Rückgängig (`undo` ohne `reason`) und `redo` sind selbst **keine** Aktionen — deshalb ändert sich für reine Stiftstriche nichts (letzter sichtbarer Strich). Wie bisher zählt die Seite, nicht das Gerät: Rückgängig trifft auch die letzte Aktion eines anderen Geräts. Gespeichert wird sofort (`persistPage`, kein Debounce).

`redo()` arbeitet den Redo-Stapel ab (`_redoStacks`, pro Seite, nur im Speicher, nur eigenes Rückgängig). Einträge:

- `{ kind: 'undo', eventId }` — eigenes `undo`-Event (auf Strich oder edit): Wiederholen hängt `redo` mit `targetEventId` an.
- `{ kind: 'delete', strokeId }` — zurückgenommenes Löschen: Wiederholen hängt ein neues Lösch-`undo` (`reason: 'delete'`) an, sofern das Objekt noch sichtbar ist.

Ein neuer eigener Strich, eine eigene Änderung (edit, Löschen, Duplizieren) oder ein festgeschriebenes Leeren verwirft den Stapel; Remote-Events ändern ihn nicht. Solange ein Hinweis „Seite geleert/gelöscht“ läuft, nimmt Strg+Z zuerst diesen zurück. Der Hinweis „Objekt gelöscht → Rückgängig“ hebt genau dieses Löschen auf (`restoreDeletedObject`), ohne den Stapel zu berühren.

## Relay Server (backup-relay/)

Standalone WebSocket on Plesk. **Critical setup:**

1. Use `WebSocket.Server({ port })` — NOT `{ server }`. Passenger doesn't pass WS upgrades to a custom HTTP server.
2. **Disable nginx proxy in Plesk** for the domain (otherwise nginx swallows the WS upgrade and returns 200). Ref: https://support.plesk.com/hc/en-us/articles/12377246437399
3. Client connects without port: `wss://domain/`. Plesk routes 443 to the Node process internally.
4. `node-put` with Base64 string (not object) → server replaces, doesn't merge. Ciphertext stored 1:1.

## Local Dev Relay (dev-server/)

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
- **Versionen vor v47** kennen `edit` nicht: dort bleibt ein Objekt an alter Stelle, in alter Farbe und ungefüllt; Formen erscheinen als Umriss-Stiftstrich (`points`). Löschen über die Auswahl kommt an (es ist ein `undo`). Die Events bleiben dort im Log erhalten und werden weitergereicht.
- **Radierspur wandert nicht mit:** Ein teilweise wegradiertes Objekt nimmt die Radierspur beim Verschieben/Skalieren nicht mit (Radierer-Striche sind eigene Objekte und wirken pixelweise). Ein Radierer-Strich, der *nach* einer Form gezeichnet wurde, radiert die Form auch an ihrer neuen Stelle, wenn sie dorthin geschoben wird. Der Treffertest sieht Radiertes nicht (ein wegradierter Strich bleibt anwählbar).
- **Gleichzeitige edits** entscheidet `createdAt` (Geräte-Uhr), nicht die echte Reihenfolge — bei falsch gehender Uhr gewinnt evtl. das „frühere“ Gerät; alle Geräte zeigen aber denselben Stand.
- **Kein Spiegeln** beim Ändern der Größe: eine Linie von links oben nach rechts unten lässt sich nicht zur Gegendiagonale umziehen (neu zeichnen).
- **Versionen vor v44** kennen `restoredAt` nicht: dort bleibt eine anderswo wiederhergestellte Seite gelöscht, und ein Wiederherstellen von dort kommt bei anderen nicht an.
- **Empty pages** in shared notebooks: `pushSharedNotebook` pushes pages that have events (a page whose strokes were all undone has events but zero strokes). Empty pages without events still exist only in meta. Recipient creates them from meta.
- **Firefox Stable + OPFS:** `GetDirectory` throws `SecurityError`. Falls back to IndexedDB.
- **Public Nostr relays go offline.** Trystero's default list is used; if peers stop finding each other, check signaling first (see `relayConfig` note above).
- **Firefox `network.websocket.enabled`** can be reset to `false` by updates/profile reset → all WebSockets fail.

## Commit Convention

Imperative, lowercase, concise. Examples: "Add pen-only mode toggle", "Fix shared notebook sync", "Remove dead Nostr relays".

## Debugging & Tests

- **Sync-Diagnose-Overlay** (unten rechts): standardmäßig aus. Schalter unter Einstellungen → Verbindung (`localStorage notizbuch:debugOverlay`); Klick auf den Sync-Status öffnet diesen Abschnitt. Zeigt Version, ICE-Quelle, pro Peer den Candidate-Typ (`relay` = über TURN) `striche: N (events: M)` der aktuellen Seite (N = sichtbare Objekte inkl. Formen und Radierer-Striche) und `ansicht: scale x y`.
- **Version prüfen:** Erste Overlay-Zeile muss zur `APP_VERSION` in `js/app.js` passen. Der Service Worker liefert HTML und `js/` network-first.
- **Abnahmetest Sync** (zwei isolierte Chromium-Instanzen, braucht `playwright-core`):
  ```bash
  cd dev-server && node server.js &
  PLAYWRIGHT_CORE=/pfad/zu/node_modules/playwright-core node tests/accept.cjs https://localhost:4444/app.html device
  PLAYWRIGHT_CORE=... node tests/accept.cjs https://localhost:4444/app.html shared
  ```
  Prüft Live-Sync beim Zuschauer, kein Verlust nach Relay-Zyklen, Undo auf beiden Seiten, Zustand nach Reload. Läuft auch gegen die Produktiv-URL.
- **Relay-only-Test:** Mit `NO_P2P=1` wird WebRTC im Browser blockiert — der Test muss trotzdem über den Relay-Live-Weg funktionieren:
  ```bash
  NO_P2P=1 node tests/accept.cjs https://localhost:4444/app.html device
  NO_P2P=1 node tests/accept.cjs https://localhost:4444/app.html shared
  ```
- **UI-Tests** (Screenshots nach `/tmp/notes-ui/`, alle enden mit `ERGEBNIS: ALLES OK`):
  - `node tests/ui.cjs <URL>` — Hauptansicht (Werkzeugleiste, Popover, Seiten-Pille, „Weiterer Inhalt“, Theme, Breiten)
  - `node tests/ui-b.cjs <URL>` — Schublade, Einstellungen, Teilen, Erststart
  - `node tests/ui-c.cjs <URL>` — Hinweise statt nativer Dialoge, Leeren/Löschen mit „Rückgängig“ über zwei Geräte
  - `node tests/ui-d.cjs <URL>` — Seitenübersicht, gelöschte Seiten, Wiederherstellen über zwei Geräte, 40 Seiten, 360 px
- **Redo-Test:** `node tests/redo.cjs <URL>` (zwei Kontexte, Geräte-Sync).
- **Formen + Auswahl:** `node tests/shapes.cjs <URL>` (zwei Kontexte im Geräte-Sync, `NO_P2P=1` reicht; dazu ein Kontext für die eingespielte Sicherung und einer mit Touch über CDP). Vier Formen, Verschieben/Größe/Füllung/Farbe mit Pixelproben auf beiden Geräten, Strg+Z/Redo je Änderung, gleichzeitige Änderung, Löschen/Duplizieren, Verhalten der Auswahl, Seite leeren, Reload, Vorschau/PNG/SVG, Sicherung, alter Renderer (`git show 176fc41:js/canvas.js`, Bild nach `/tmp/notes-ui/altgeraet-formen.png`), 360 px. Der Test rechnet in Weltkoordinaten und liest die Ansicht aus der Overlay-Zeile `ansicht: scale x y`.
- **Nicht geladene Seite:** `node tests/unloaded-page.cjs <URL>` (echtes P2P, Relay für B per `routeWebSocket` blockiert). B hat Seite 2 nach dem Neuladen nur als Meta; Peer-Join-`full-sync`, `stroke` und Meta-`full-sync` dürfen deren Datei nicht verkleinern (OPFS-Dateigrößen) und die Strichzahl muss stimmen.
- **Sicherung Export/Import:** `node tests/export-roundtrip.cjs <URL>` — Export mit Passphrase, Einspielen ohne Schlüssel (Erststart), mit demselben Schlüssel (Mischen, Relay blockiert), mit anderem Schlüssel (Rückfrage, Ersetzen), falsche/kurze/ungleiche Passphrase, Altformat v2 und altes Schlüsselbündel (beide im Test nachgebaut). WebRTC ist dort immer blockiert.
- Die Tests prüfen `APP_VERSION` (ui.cjs, ui-b.cjs) — beim Hochzählen anpassen.
- **Drei-Peer-Test:** `node tests/three.cjs` baut ein Teilnetz (Handy und Tablet ohne direkte Verbindung) und prüft, dass der mittlere Peer Striche und Undo weiterreicht — auch zwischen Haupt-Room und Shared-Room (`forwardSyncEvent`).
- **TURN-Test:** `node tests/turntest.cjs` prüft jeden TURN-Eintrag des ICE-Endpunkts mit erzwungenem Relay.
