# PLAN.md — Notizbuch App

## Aktueller Stand (Stand 2026-04-20)

App ist produktiv deployed unter `notizbuch-app.vercel.app`. Backup-Relay läuft auf Plesk (`wss://notes.mike.fm-media-staging.at`).

**Architektur** (siehe CLAUDE.md für Details):
- WebRTC P2P (Trystero, Nostr-Signaling, Multi-Room) — Live-Sync
- Plesk WebSocket-Relay — Backup-Snapshot-Store für Offline-Peers
- AES-GCM 256 (zufälliger MasterKey + NotebookKeys, kein Passphrase)
- OPFS-Storage mit IndexedDB-Fallback
- Modulare JS-Architektur (`js/*.js`), `app.html` nur UI

## Offene Punkte

### Peer-Freigabe (Sicherheit, geplant)

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

- **Concurrent shared edits**: Race-Window ~500ms (zwischen Fetch und Push) bei gleichzeitigem Zeichnen aus zwei Browsern. Kann einzelne Strokes verlieren — akzeptabel für typische asynchrone Nutzung.
- **Key-Verlust = Datenverlust**: Bei zufälligem MasterKey gibt es kein Recovery. Erst-Start-Dialog warnt + erzwingt Bestätigung.
- **Öffentliche Nostr-Relays unzuverlässig**: Liste in `js/p2p-sync.js` muss gelegentlich gepflegt werden.

## Letzte Änderungen

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
