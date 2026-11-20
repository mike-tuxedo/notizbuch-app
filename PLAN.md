# PLAN.md — Notizbuch App

## Aktueller Stand (Stand 2026-11-20)

App ist produktiv deployed unter `notizbuch-app.vercel.app` (Version `2026-11-20-relaylive-v39`). Relay läuft auf Plesk (`wss://notes.mike.fm-media-staging.at`). Sync auf 3 Geräten bestätigt.

**Architektur** (siehe CLAUDE.md für Details):
- Relay leitet verschlüsselte Events live weiter (funktioniert ohne WebRTC) + Blob-Abgleich für Offline-Geräte
- WebRTC P2P (Trystero 0.24.0 gepinnt, Nostr-Signaling, Multi-Room) als Beschleunigung
- TURN/ICE pro Gerät einstellbar (Sidebar → „Verbindung“)
- Seiten als Event-Log (Format v2), Vereinigung nach Event-ID, Undo als Event
- AES-GCM 256 (zufälliger MasterKey + NotebookKeys, kein Passphrase)
- OPFS-Storage mit IndexedDB-Fallback
- Abnahmetests in `dev-server/tests/`

## Vorrang: Redesign und neue Werkzeuge

Abgenommener Klickdummy: `artifacts/redesign/index.html` (Absichten, Token-Tabelle und Zuordnung alt → neu in `artifacts/redesign/README.md`). Zielgeräte in dieser Reihenfolge: großes Zeichen-Tablet mit Stift, Tablet, Handy.

### Etappe 1 — Redesign, Redo, Seitenübersicht (umgesetzt 2026-11-20, lokal, Version `2026-11-20-redesign-v45`)

- [x] Token-System, helles und dunkles Theme (Zeichenfläche immer weiß, Akzent hell Petrol `#0b7285`, dunkel `#74b8ff`), zwei Textstufen mit hohem Kontrast
- [x] Werkzeugleiste: Hand als Schalter, Farbe und Strichstärke als getrennte Knöpfe, Seiten-Menü „⋯“ für Seltenes
- [x] Redo (Event-Typ `redo`, Sync-Aktion `redo`)
- [x] Seiten: `‹ 3 / 7 ›` mit „+“, Seitenübersicht mit Vorschaubildern, gelöschte Seiten nur noch dort
- [x] Zoom-Pille `− [Alles] +` und Hinweis auf Inhalt außerhalb des Bildschirms (richtungsabhängig, nie automatisch verschieben)
- [x] Notizbuch-Liste hinter dem Titel, nicht anheftbar; einheitliches „⋯“-Menü statt Hover/Longpress
- [x] Einstellungen an einem Ort (inkl. Relay-Adresse), ein Teilen-Dialog (Einladen / Beitreten)
- [x] Hinweise mit „Rückgängig“ und eigene Dialoge statt `confirm()`/`prompt()`/`alert()`
- [x] Tastaturkürzel, Fokus-Ring, `aria-label`s, 44-px-Bedienflächen bei `pointer: coarse`
- [x] Mitbehoben: Seite wiederherstellen kommt bei anderen Geräten an (`restoredAt`), Seiten-Meta live in geteilten Notizbüchern, Reconnect-Schleife im Relay-Live-Kanal, Event-Log-Verlust bei Sync auf nicht geladene Seiten

Noch offen aus Etappe 1:

- [ ] Auf echten Geräten prüfen (Zeichen-Tablet mit Stift, Tablet, Handy; Touch, Kamera-Scan, Safe-Area), dann deployen
- [ ] Export/Import: die exportierte `.enc`-Datei lässt sich nicht importieren (Export mit MasterKey, Import erwartet Passphrase; `tests/export-roundtrip.cjs` zeigt es). Entscheidung nötig, wie die Sicherung aussehen soll
- [ ] Mischbetrieb: Geräte mit alter Version zeigen Redo und wiederhergestellte Seiten nicht, bis sie die neue Version laden

### Etappe 2 — Füllen, Formen, Auswahl

Braucht neue Event-Typen und greift in Sync und Rendering ein.

- [ ] Füllwerkzeug als Vektorfläche (bleibt beim Zoomen scharf, liegt als Event im Log)
- [ ] Formen: Rechteck, Ellipse, Linie, Pfeil
- [ ] Auswahl-Werkzeug: Größe und Position ändern, Duplizieren, Löschen; Auswahlrahmen in Petrol

### Im Klickdummy enthalten, aber nicht entschieden

- Einstellung „Finger bewegen die Seite, Stift zeichnet“
- Aufbewahrungsfrist für gelöschte Seiten („30 Tage“ ist nur Beispieltext)
- Gerätenamen unter „Meine Geräte“ (heute gibt es nur Geräte-IDs)

## Weitere offene Punkte (zweitrangig)

### Sync / Infrastruktur

- [x] Relay-URL als Einstellung (Einstellungen → Verbindung, gerätelokal)
- [ ] Für öffentliche Version: Relay + Signaling serverless (z.B. Cloudflare Workers / Durable Objects)
- [ ] Signaling: Trystero-Standard-Relays sind unzuverlässig; eigene geprüfte Liste (`relayConfig.urls`) oder eigener Broker
- [ ] Event-Log kompaktieren (wächst unbegrenzt)
- [ ] Undo nur für eigene Striche?
- [ ] Trystero-Migration auf 0.27 (großer API-Bruch)
- [ ] Mischbetrieb/Regression testen: Radierer, Seite leeren, mehrere Seiten

### Peer-Freigabe (Sicherheit, geplant — prüfen, ob veraltet: Freigaben gibt es schon pro Notizbuch)

- [ ] Owner muss Peers für geteilte Notebooks freigeben
- [ ] Peer sendet UserKey beim Beitreten
- [ ] Peer-Management UI (verbundene Peers anzeigen, freigeben/blockieren)

### Performance

- [ ] Inkrementelles Stroke-Rendering bei >500 Strokes
  - Bisheriger Versuch (DPR + setTransform) hatte visuelle Regressions, reverted
- [ ] Lazy-Load Strokes bei sehr großen Notebooks

### Testing

- [ ] Mobile-Testing: Brave Android, Safari iOS, Firefox Android
- [ ] Firefox Stable: OPFS `GetDirectory` SecurityError — Fallback verifizieren

## Bekannte Limitierungen

- **Key-Verlust = Datenverlust**: Bei zufälligem MasterKey gibt es kein Recovery. Erst-Start-Dialog warnt + erzwingt Bestätigung.
- **Öffentliche Nostr-Relays unzuverlässig**: betrifft nur noch den P2P-Weg, Live-Sync läuft auch über das Relay.

## Letzte Änderungen

### Session 2026-11-19..20

- [x] **Trystero gepinnt** (ungepinnter Import war seit 0.27 kaputt)
- [x] **TURN/ICE-Einstellung** pro Gerät + Diagnose-Overlay (ein/aus per Klick auf Statuszeile)
- [x] **Event-Log-Migration fertig** (Undo wirkt, kein Snapshot-Überschreiben mehr)
- [x] **Weiterleitung zwischen Haupt- und Shared-Room** (Teilnetze mit 3 Geräten)
- [x] **Live-Weiterleitung im Relay** (Sync ohne P2P)
- [x] **Service Worker**: HTML + JS network-first
- [x] **Abnahmetests** (2 Peers, 3 Peers, nur Relay, TURN)

### Session 2026-04-18..20

- [x] **Stiftmodus-Toggle** in Sidebar (Touch-Zeichnen blockieren auch wenn Pen weg)
- [x] **Multi-Room P2P** für geteilte Notebooks (notebookHash als P2P-Room)
- [x] **Fetch-Merge-Push** für shared Relay (verhindert Überschreiben fremder Daten)
- [x] **Shared Notebook OPFS-Persistenz** (Strokes nach Merge auf Disk speichern)
- [x] **Notebook umbenennen/löschen**: Hover-Icons (Desktop) + Longpress-Kontextmenü (Touch)
- [x] **fitToContent pixel-basiert**: Radierte Bereiche werden korrekt ignoriert
- [x] **Cleanup**: nostr-relay/ Versuch entfernt, alte Branches gelöscht, .gitignore erweitert

### Session 2026-04-02..03

- [x] **Key/Auth-Umbau**: Zufälliger MasterKey statt Passphrase
- [x] **URL-Hash pro Notebook** (`#nb-{hash}`), Bookmark-Navigation
- [x] **Share-Links** (`#nb-{hash}&k={key}&name={name}`)
- [x] **Geräte-Sync via QR-Code** (Sidebar-Button mit voller Sync-URL)
- [x] **Plesk-Relay** deployed (`wss://notes.mike.fm-media-staging.at`)

### Session 2026-03-26..27

- [x] **Modulare Architektur** auf `js/*.js` umgestellt
- [x] **Trystero P2P** statt GenosDB (Multi-Room-fähig, kein eigener Sync-Code)
- [x] **OPFS + AES-GCM** Verschlüsselung
- [x] **Notebook-Sharing** mit Invite-Links
- [x] **Export/Import** als passphrase-protected .enc Bundle
