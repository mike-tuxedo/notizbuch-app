# PLAN.md — Notizbuch App

## Aktuell: Key/Auth-Umbau (Stand 2026-04-02)

### Ziel

Passphrase-basierte Authentifizierung durch zufällige Keys ersetzen. Zwei URL-Hash-Formate für unterschiedliche Anwendungsfälle.

### URL-Hash Formate

| Format | Zweck | Beispiel |
|--------|-------|---------|
| `#{masterKeyHash}` | Kompletter App-State syncen (eigene Geräte) | `app.html#3e577620422663d2` |
| `#nb-{notebookHash}` | Einzelnes Notebook öffnen/teilen | `app.html#nb-a7f3b2c8d9e1f052` |

### Schlüssel-Hierarchie (Neu)

```
MasterKey (AES-GCM 256, zufällig generiert — KEIN Passphrase)
  ├── verschlüsselt meta.bin (Notebook-Struktur + alle NotebookKeys)
  ├── SHA-256(MasterKey)[0:16] = masterKeyHash
  │     → Relay-Room (alle Notebooks eines Users)
  │     → P2P-Room (alle eigenen Geräte)
  │     → URL-Hash für Geräte-Sync: #{masterKeyHash}
  │
  └── NotebookKey pro Notebook (AES-GCM 256, zufällig)
        ├── verschlüsselt Stroke-Daten (OPFS + Relay)
        └── SHA-256(NotebookKey)[0:16] = notebookHash
              → URL-Hash für Sharing: #nb-{notebookHash}
```

### Phase 1: MasterKey-Generierung umstellen

Passphrase-Dialog durch Key-Generierung + Import ersetzen.

**Erst-Start-Dialog (kein gespeicherter Key, kein URL-Hash):**
1. Zwei Optionen: "Neu starten" oder "Key importieren"
2. Bei "Neu starten": `generateKey()` → Key anzeigen (Hex) + .txt Download anbieten
3. Hinweis: "Aus Sicherheitsgründen wird empfohlen, den Key manuell aufzuschreiben"
4. Bestätigung: "Ich habe den Key gesichert" → erst dann weiter
5. Bei "Key importieren": Textfeld + Datei-Upload → Key laden, App synct

**URL mit MasterKey-Hash (von anderem Gerät kopiert):**
- Hash erkennen (kein `nb-` Prefix) → Key-Import-Dialog zeigen
- Nach Import: App synct über Relay + P2P mit gleichem Room

**Änderungen:**
- [ ] `initMasterKey()` → prüft localStorage, dann URL-Hash, dann Erst-Start-Dialog
- [ ] `showPassphraseDialog()` → entfernen
- [ ] `deriveMasterKey()` / `MASTER_SALT` → entfernen
- [ ] Neues Modal: Key-Anzeige + Export + Bestätigung
- [ ] Neues Modal: Key-Import (Textfeld + Datei)
- [ ] `roomKey` Variable umbenennen zu `masterKeyHash` (17 Referenzen in app.js)

**Betroffene Dateien:** app.js, app.html (Modals)

### Phase 2: URL-Hash pro Notebook

Notebook-spezifische URLs für Navigation und Sharing.

**URL-Hash Logik:**
- Init: `window.location.hash = 'nb-' + currentNotebookHash`
- Notebook-Wechsel: Hash aktualisieren
- `hashchange`-Event: Notebook wechseln wenn Hash manuell geändert
- Format-Erkennung: `#nb-...` = Notebook, `#...` (ohne Prefix) = MasterKey

**P2P + Relay bleiben auf MasterKey-Room:**
- P2P-Room-Wechsel bei Nostr-Signaling ist 5-15s → zu langsam pro Notebook
- Ein Master-Room für eigene Geräte (Full-Sync aller Notebooks)
- Separate Rooms erst beim Sharing (Phase 3)

**Änderungen:**
- [ ] `notebookHash(notebookId)` Hilfsfunktion: SHA-256(NotebookKey) → Hex
- [ ] URL-Hash bei Init + Notebook-Wechsel setzen
- [ ] `hashchange`-Listener für manuelle Navigation
- [ ] Settings-Keys: `masterKeyHash + ':...'` statt `roomKey + ':...'`
- [ ] Alte URL-Formate erkennen (Abwärtskompatibilität)

**Betroffene Dateien:** app.js, share.js

### Phase 3: Sharing + Peer-Freigabe (später)

- [ ] Invite-Links: `#nb-{notebookHash}&k={base64(notebookKey)}&name={name}`
- [ ] Separater P2P-Room pro geteiltem Notebook
- [ ] Owner muss Peers freigeben (Peer sendet UserKey)
- [ ] Peer-Management UI (verbundene Peers anzeigen, freigeben/blockieren)

### Migration

- Bestehende MasterKeys in localStorage funktionieren weiter (gültige AES-256 Keys, egal ob via PBKDF2 oder random generiert)
- Alte URL-Hashes ohne `nb-` Prefix werden als MasterKey-Hash erkannt
- Keine Daten-Migration nötig

### Risiken

- **Key-Verlust = Datenverlust**: Erst-Start-Dialog muss aggressiv warnen. Download erzwingen + Bestätigung.
- **P2P-Room bleibt global**: Alle Notebooks über einen Room — beim Sharing könnte ein Peer theoretisch Full-Sync aller Notebooks empfangen. Fix erst in Phase 3 (separate Rooms).

---

## Erledigte Arbeiten

### Session 2026-04-02

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
