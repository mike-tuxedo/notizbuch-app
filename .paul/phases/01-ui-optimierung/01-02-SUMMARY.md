---
phase: 01-ui-optimierung
plan: 02
subsystem: pwa
tags: [pwa, manifest, service-worker, icons, android, installability]

requires:
  - phase: 01-ui-optimierung / plan 01-01
    provides: Daily-Driver-fähiges Mobile-UI (Vorausetzung, dass standalone überhaupt sinnvoll ist)

provides:
  - PWA-Standalone-Installierbarkeit auf Android (Chrome)
  - Manifest mit 192×192 + 512×512 Maskable-Icons
  - Service-Worker-Cache v43 mit neuen Icons in OPTIONAL_ASSETS

affects:
  - Künftige PWA-Features (Push, Background-Sync) profitieren von valider Manifest-Basis
  - Plan 01-03 (Zen-Mode-Layout-Fix) — neuer Fund aus Re-Test

tech-stack:
  added: []
  patterns:
    - "Manifest-Icon-Pattern: any-maskable-purpose für adaptive Android-Launcher"
    - "Service-Worker-Cache-Bump-Konvention: notizbuch-vNN bei jeder Änderung an cached Assets"

key-files:
  created:
    - img/icon-192.png
    - img/icon-512.png
  modified:
    - manifest.json
    - sw.js

key-decisions:
  - "Lanczos-Upscale 180→192 (~7% Upscale, unkritisch) und 180→512 (~2.84×, leicht weicher) statt Hi-Res-Master"
  - "Maskable + any Purpose kombiniert (purpose: any maskable) für maximale Launcher-Kompatibilität"
  - "Neue Icons in OPTIONAL_ASSETS (nicht STATIC_ASSETS) — konsistent mit bestehenden apple-touch-icon-Einträgen"

patterns-established:
  - "PWA-Install-Test-Routine: SW unregister → Reload → DevTools/Application/Manifest → Install via Drei-Punkt-Menü"

duration: ~10min
started: 2026-05-04T00:00:00Z
completed: 2026-05-05T00:00:00Z
---

# Phase 1 Plan 02: PWA Install Fix Summary

**PWA installiert sich auf Android Chrome jetzt im Standalone-Modus: 192×192 + 512×512 Maskable-Icons aus 180×180 Lanczos-upscaled, im Manifest registriert, Service-Worker-Cache von v42 auf v43 gebumped.**

## Performance

| Metric | Value |
|--------|-------|
| Duration | ~10 min |
| Started | 2026-05-04 |
| Completed | 2026-05-05 |
| Tasks | 3 (2 auto + 1 human-verify) |
| Files modified | 2 (`manifest.json`, `sw.js`) |
| Files created | 2 (`img/icon-192.png`, `img/icon-512.png`) |

## Acceptance Criteria Results

| Criterion | Status | Notes |
|-----------|--------|-------|
| AC-1: Icons 192 + 512 valide PNGs | Pass | `file` zeigt korrekte Dimensionen RGBA non-interlaced |
| AC-2: Manifest registriert beide Icons | Pass | Icons-Array hat 11 Einträge; beide neuen mit `purpose: "any maskable"`; display "fullscreen" unverändert; JSON-valide via python3 |
| AC-3: SW-Cache aktualisiert | Pass | CACHE_NAME `notizbuch-v42` → `v43`; neue Icons in OPTIONAL_ASSETS (konsistent mit apple-touch-icon-Einträgen) |
| AC-4: PWA Standalone-Install auf Android funktioniert | Pass | User-Verifikation: "funktioniert ganz gut" — Install-Option verfügbar, Standalone-Mode beim Start aus Homescreen |

## Accomplishments

- Android-Chrome erkennt App jetzt als installierbar — vorher fehlten 192/512-Icons, was Chrome zur Verweigerung des Standalone-Installs führte.
- Maskable-Icons sind für moderne Android-Launcher (Pixel-Style adaptive Icons) optimal — eine Icon-Variante deckt Square/Round/Squircle-Cuts ab.
- iOS-Pfad bleibt unangetastet — alle bestehenden apple-touch-icon-Größen sind weiter im Manifest, keine Regression auf iPhone.

## Task Commits

Keine atomaren Commits pro Task.

## Files Created/Modified

| File | Change | Purpose |
|------|--------|---------|
| `img/icon-192.png` | Created | 192×192 PNG (Lanczos-Upscale aus 180), RGBA |
| `img/icon-512.png` | Created | 512×512 PNG (Lanczos-Upscale aus 180), RGBA |
| `manifest.json` | Modified | 2 neue Icon-Einträge mit `purpose: "any maskable"` |
| `sw.js` | Modified | CACHE_NAME v42→v43; neue Icons in OPTIONAL_ASSETS |

## Decisions Made

| Decision | Rationale | Impact |
|----------|-----------|--------|
| Lanczos-Upscale aus 180er statt Hi-Res-Master | Schnellster Pfad zur Installierbarkeit, kein externes Asset nötig | 512er minimal weicher als nativ; bei Bedarf später durch Hi-Res-Quelle ersetzen |
| `purpose: "any maskable"` (kombiniert) | Maximale Kompatibilität — fungiert als sowohl regulär als auch maskable | Falls Hi-Res-Master später kommt: explizite Trennung `any` + `maskable` in zwei Einträgen erwägen |
| Icons in OPTIONAL_ASSETS, nicht STATIC | Konsistent mit bestehenden apple-touch-icon-Einträgen — Icons sind nicht critical für Funktion | Falls Manifest-Validator strikter wird, in STATIC verschieben |

## Deviations from Plan

### Summary

| Type | Count | Impact |
|------|-------|--------|
| Auto-fixed | 0 | — |
| Scope additions | 0 | — |
| Deferred (neu) | 1 | Logged to STATE.md |

**Total impact:** Plan-Track exakt durchgezogen. Ein neuer Fund (Zen-Mode-Layout) bei der Re-Verifikation, separat als 01-03 geplant.

### Deferred Items

- **Zen-Mode-Layout auf Mobile**: Pen-Icon kann in der Selfie-Cam-Zone landen; großer Spalt zwischen Tool-Group und Color/Size-Group; Toolbar steht nicht "ganz oben". Ursache: `.toolbar-right { margin-left: auto }` aus 01-01 überschreibt zen-modes `justify-content: center`; zen-mode erbt `padding-top: var(--safe-top)`. Wird in Plan 01-03 adressiert.

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| 180×180 → 512×512 Upscaling-Qualität | Lanczos-Filter gewählt; Resultat akzeptiert mit Hinweis im Plan auf späteren Hi-Res-Replace |
| Zen-Mode-Layout-Bug aufgefallen während Mobile-Test | Außerhalb der Plan-Boundaries (`app.html` DO NOT CHANGE) — als Deferred für 01-03 logged statt Boundary-Lift |

## Skill Audit

| Expected Skill | Invoked? | Notes |
|----------------|----------|-------|
| `/simplify` (optional) | ○ | Nicht erforderlich — kein Refactor-Bedarf |

Keine `required` Skills für diesen Plan.

## Next Phase Readiness

**Ready:**
- PWA-Foundation funktional auf Android und iOS — Install-Pfad freigeschaltet.
- Solide Basis für Plan 01-03 (Zen-Mode-Layout-Fix), der wieder `app.html` anfasst.

**Concerns:**
- 512er-Icon ist Upscale, könnte bei großen Adaptive-Icon-Tiles sichtbar weicher sein. Falls visuell störend → Hi-Res-Master beschaffen.

**Blockers:**
- Keine.

---
*Phase: 01-ui-optimierung, Plan: 02*
*Completed: 2026-05-05*
