# Notizbuch – Redesign-Klickdummy

Einstieg: `index.html` (im Browser öffnen, kein Server nötig). Oben die gestrichelte Leiste gehört zum Prototyp, nicht zur App: Screens wechseln, Hell/Dunkel, Handy-Vorschau.

| Datei | Inhalt |
|---|---|
| `index.html` | Hauptansicht: Werkzeugleiste, Zeichenfläche, Seiten- und Zoom-Pille, Notizbuch-Schublade |
| `seiten.html` | Seitenübersicht mit Vorschaubildern, „Neue Seite“, gelöschte Seiten |
| `einstellungen.html` | Ein Ort für Allgemein, Geräte, Verbindung, Daten & Schlüssel |
| `teilen.html` | Ein Dialog: Einladen / Beitreten |
| `states.html` | Komponenten und Zustände hell und dunkel nebeneinander, Erststart-Schlüssel, Lösch-Rückfrage |
| `ist-*.png` | Referenz-Screenshots der heutigen App |
| `preview-*.png` | Screenshots des Prototyps |
| `_src/` | Quellen. Nach Änderungen: `python3 _src/build.py` |

## Absichten

- **Zeichenfläche ist die App.** Dauerhaft sichtbar sind nur: Notizbuch-Titel, Hand-Schalter, 5 Werkzeuge, Farbe, Strichstärke, Undo/Redo, Sync-Status, Seiten-Menü.
- **Hand ist ein Schalter, kein Werkzeug.** An = bewegen/zoomen, aus = zurück zum zuletzt benutzten Werkzeug. Ein Werkzeug antippen schaltet die Hand ebenfalls aus. Leertaste halten = vorübergehend bewegen.
- **Farbe und Strichstärke** sind zwei getrennte Knöpfe in der Werkzeugreihe; jeder zeigt den aktuellen Stand und öffnet nur seine eigene Auswahl. Weiß ist aus der Palette entfernt (Papier ist immer weiß).
- **Selten Gebrauchtes** (Papierart, Export, Vollbild, Seite leeren/löschen) liegt im Seiten-Menü „⋯“.
- **Seiten:** `‹ 3 / 7 ›` plus ausdrückliches „+“. Tipp auf den Zähler öffnet die Übersicht.
- **„Alles zeigen“ statt Prozentzahl.** Die Pille unten rechts ist `− [Alles] +`. „Alles“ ist das frühere Haus (`fitToContent`): passt den gesamten gezeichneten Bereich ein. Eine Prozentzahl gibt es nicht, weil sie je Gerät etwas anderes bedeuten würde.
- **Hinweis auf Unsichtbares.** Liegt Gezeichnetes außerhalb des Bildschirms, bekommt „Alles“ einen Punkt und am Rand erscheint „Weiterer Inhalt →“. Im Prototyp ausgelöst durch Hineinzoomen (+). In der App: Vergleich der Inhalts-Bounding-Box mit dem sichtbaren Ausschnitt, neu geprüft bei Pan/Zoom und bei eingehenden Sync-Strichen – ohne die Ansicht ungefragt zu verschieben.
- **Rückmeldung statt Rückfrage:** Leeren und Löschen einer Seite zeigen einen Hinweis mit „Rückgängig“. Eine echte Rückfrage gibt es nur beim Löschen eines Notizbuchs.
- **Lesbarkeit:** zwei Textstufen statt drei, beide über 8:1. Mindestschriftgröße 13 px (Werkzeug-Beschriftung 12 px, fett).
- **Bedienflächen** mindestens 44 px, nicht nur unter 768 px. Ausnahme: Werkzeugreihe auf dem Handy 40 × 44 px (wie heute), damit 8 Knöpfe auf 360 px passen.
- **Breiten:** ab 1180 px Werkzeuge mit Beschriftung (großes Zeichen-Tablet), darunter nur Symbole, unter 760 px wandern die Werkzeuge nach unten.

## Neue Funktionen im Prototyp

| Funktion | Wo | Hinweis zur Umsetzung |
|---|---|---|
| Redo | Leiste rechts | Event-Log: Redo = `undo`-Event wieder aufheben; neuer Strich leert den Redo-Stapel |
| Füllen | Werkzeug | Flächenfüllung auf Pixelbasis, als eigenes Event gespeichert (Startpunkt + Farbe) oder als Polygon – offen |
| Seitenübersicht | `seiten.html` | Vorschaubilder aus `strokeCacheCanvas`; gelöschte Seiten nutzen vorhandenes `deletedAt`/`restorePage` |
| Formen | Werkzeug mit Auswahl Rechteck/Ellipse/Linie/Pfeil | neuer Event-Typ `shape` mit Geometrie |
| Auswahl | Werkzeug | Griffe für Größe/Position, kleine Leiste für Farbe, Füllung, Duplizieren, Löschen; Änderung als neues Event |
| Finger bewegen, Stift zeichnet | Einstellungen → Eingabe | macht den Hand-Schalter auf Stift-Geräten meist überflüssig |
| Hinweis „Weiterer Inhalt“ | Zeichenfläche, Pille unten rechts | braucht die Bounding-Box der Seite; die pixelbasierte Variante aus `fitToContent` ist dafür zu teuer, Strich-Grenzen reichen |
| Tastenkürzel | P, E, F, S, V, H, 0 (alles zeigen), Leertaste | im Prototyp aktiv |

## Tokens

| Token | Hell | Dunkel | Nutzung |
|---|---|---|---|
| `--bg` | `#eef0f3` | `#111317` | Seitenhintergrund außerhalb der Zeichenfläche |
| `--surface` | `#ffffff` | `#1b1e24` | Leisten, Dialoge, Menüs |
| `--surface-2` | `#f1f3f6` | `#262a32` | Hover, Hinweisfelder |
| `--border` | `#d3d8e0` | `#3b414c` | Trennlinien (dekorativ) |
| `--border-strong` | `#7d8797` | `#8791a1` | Ränder von Buttons und Eingaben (≥ 3:1) |
| `--text` | `#14171c` | `#f3f5f8` | Text, Symbole |
| `--text-2` | `#3f4755` | `#c9cfd9` | Nebentext |
| `--accent` | `#0b7285` (Petrol) | `#74b8ff` | Aktiv, primäre Aktion, Fokusring |
| `--accent-soft` | `#dcf1f4` | `#1c3554` | Hintergrund aktiver Elemente |
| `--on-accent` | `#ffffff` | `#08182b` | Text auf Akzent |
| `--danger` / `--danger-soft` | `#b3261e` / `#fbe9e7` | `#ff8f85` / `#3d1f1d` | Löschen, Fehler |
| `--ok` / `--warn` | `#17754a` / `#8a5800` | `#62d6a0` / `#f2c060` | Sync-Status |
| `--paper` | `#ffffff` | `#ffffff` | Zeichenfläche, themenunabhängig |
| `--paper-line` | `#dde3ec` | `#dde3ec` | Karo/Linien |
| `--s1`…`--s6` | 4 / 8 / 12 / 16 / 24 / 32 px | | Abstände |
| `--tap` | 44 px | | Mindestgröße Bedienfläche |
| `--bar-h` | 56 px | | Werkzeugleiste |
| `--drawer-w` | 300 px | | Notizbuch-Schublade |
| `--r-sm` / `--r-lg` / `--r-pill` | 8 / 14 / 999 px | | Bedienelemente / Flächen / Pillen |
| `--font-ui` | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` | | UI |
| `--fs-sm` / `--fs-md` / `--fs-lg` / `--fs-xl` | 13 / 15 / 17 / `clamp(20px, 2.4vw, 26px)` | | Schriftgrößen |

Gemessene Kontraste: Text 18,0 (hell) / 15,3 (dunkel), Nebentext 9,4 / 10,7, Akzent auf Fläche 5,6 / 8,0, Akzent auf `--accent-soft` 4,8 / 6,0, `--border-strong` auf Fläche 3,6 / 5,2.

## Alt → Neu (für die Übernahme in `app.html`)

| Alt | Neu (dunkel) | Anmerkung |
|---|---|---|
| `--bg #0e0d15` | `--bg #111317` | |
| `--surface #171622` | `--surface #1b1e24` | |
| `--surface-2 #1f1d30` | `--surface-2 #262a32` | |
| `--border #2b2840` | `--border #3b414c` | |
| `--border-2 #3a3658` | `--border-strong #8791a1` | deutlich heller, damit Ränder erkennbar sind |
| `--text #eae8f5` | `--text #f3f5f8` | |
| `--text-dim #b0acc8` | `--text-2 #c9cfd9` | |
| `--text-faint #6c6886` | entfällt → `--text-2` | hatte nur 3,4:1 – Ursache für „Schrift zu dunkel“ |
| `--accent #4dabf7` | `--accent #74b8ff` | hell: `#0b7285` (Petrol, bewusst anderer Farbton als dunkel) |
| `--accent-dim`, `--accent-glow` | `--accent-soft` | |
| `--danger #ff6b6b` | `--danger #ff8f85` | hell: `#b3261e` |
| `--paper #f5f5f0` | `--paper #ffffff` | |
| `#5fb98a` (Status-Punkt, hartkodiert) | `--ok` | |
| `--toolbar-h 48px` | `--bar-h 56px` | |
| `--pagebar-h 44px` | entfällt | Seitenleiste ist eine schwebende Pille |
| `--sidebar-w 220px` | `--drawer-w 300px` | Schublade statt fester Spalte |
| `--tap-target 44px` | `--tap 44px` | gilt jetzt bei jeder Breite |
| Radien 2/4/5/6/8/12 | `--r-sm 8`, `--r-lg 14` | |
| `.tool-btn`, `.page-btn`, `.bg-btn`, `.footer-btn`, `.nb-add-btn`, `.copy-btn`, `.modal-close`, `.nb-action-btn` | `.btn` + `.primary` / `.ghost` / `.danger` / `.icon` | |
| `.size-btn`, `.color-dot` | `.size`, `.swatch` in je einem eigenen Menü (`.opt`) | |
| Haus-Knopf (`#btn-reset-view`) | „Alles“ in der Pille unten rechts | |
| 5 Modals (Teilen, Scan, Geräte-Sync, Verbindung, Export) | `teilen.html` + `einstellungen.html` | |
| `confirm()` / `prompt()` / `alert()` (18 Stellen) | Toast mit „Rückgängig“, Eingabefelder im Dialog | |

## Offene Punkte

- Gerätenamen in „Meine Geräte“: heute gibt es nur Geräte-IDs. Benennen ermöglichen?
- Füllen: Pixel-Füllung (einfach, aber auflösungsabhängig) oder Vektor-Fläche (sauber beim Zoomen, aufwendiger)?
- Sollen Formen auch von geteilten Teilnehmern verschoben werden dürfen (gleiche Frage wie „Undo nur für eigene Striche“)?
- Schublade auf dem großen Tablet anheftbar machen oder immer als Überlagerung?
- Testbuch-Knopf: nur noch bei eingeschalteter Sync-Diagnose anzeigen.
