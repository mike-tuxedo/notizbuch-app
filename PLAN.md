# PLAN.md — Notizbuch App

## Nächste Schritte

### Sharing: Peer-Freigabe (geplant)

- [ ] Separater P2P-Room pro geteiltem Notebook
- [ ] Owner muss Peers freigeben (Peer sendet UserKey)
- [ ] Peer-Management UI (verbundene Peers anzeigen, freigeben/blockieren)

### Sonstiges

- [ ] Mobile-Testing: Brave Android, Safari iOS, Firefox Android
- [ ] Firefox Stable: OPFS `GetDirectory` SecurityError — Fallback testen
- [ ] Inkrementelles Stroke-Rendering (Performance bei >500 Strokes)

### Risiken

- **Key-Verlust = Datenverlust**: Erst-Start-Dialog warnt aggressiv. Download + Bestätigung.
- **P2P-Room bleibt global**: Alle Notebooks über einen Room — beim Sharing könnte ein Peer theoretisch Full-Sync aller Notebooks empfangen. Fix bei Peer-Freigabe (separate Rooms).

---

## Erledigte Arbeiten

### Session 2026-04-02/03

- [x] **Key/Auth-Umbau Phase 1:** Zufälliger MasterKey statt Passphrase, Erst-Start-Dialog, Key-Anzeige + Export, Key-Import (Hex + Datei)
- [x] **Key/Auth-Umbau Phase 2:** URL-Hash `#nb-{notebookHash}` pro Notebook, hashchange-Listener, Bookmark-Navigation
- [x] **Key/Auth-Umbau Phase 3:** Share-Links mit `#nb-{hash}&k={key}` Format, Abwärtskompatibilität mit altem `#nb={id}` Format
- [x] **Relay-Plesk:** Standalone WebSocket.Server für Plesk/Passenger (`relay-plesk/`)
- [x] **Nostr-Relays:** Tote Relays entfernt (relay.nostr.band, eigener Relay)
- [x] **Mobile Portrait:** Zweizeilige Toolbar, einzeilig im Zen-Mode
- [x] **fitToContent:** Automatische Zentrierung bei Init, Resync, Seitenwechsel
- [x] **Canvas-Crash Fix:** Guard gegen 0-Dimensionen in setupCanvases/redrawStrokes
- [x] **Cleanup:** app-v2.html → app.html, debug.html entfernt, main = experiment/yjs-sync

### Session 2026-03-27b

- [x] Seite löschen, Hintergrund-Auswahl, Relay v2, NotebookKey-Sharing, Relay-Reconnect

### Session 2026-03-26/27

- [x] Modulare Architektur, Storage, Canvas Engine, Dark Theme UI, Verschlüsselung, Sharing, Export/Import, Touch/Palm-Rejection

### Session 2026-03-25

- [x] rootDb/pageDb Split, Relay-Merge, Stale-Guard, pageLoading-State, Notebook-Löschung

### Session 2026-03-23/24

- [x] E2E-Verschlüsselung, Relay-Persistenz, Bitmap-Cache, Graph-Migration, Live-Channel

### Session 2026-03-22

- [x] Sync-Bugs, Relay-Server, HTTPS Dev-Server, Share-Links, Service Worker
