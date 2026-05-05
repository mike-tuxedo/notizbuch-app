---
phase: 01-ui-optimierung
plan: 01
subsystem: ui
tags: [css, mobile, safe-area, touch-targets, contrast, pwa, dark-theme, accessibility]

requires:
  - phase: none (first plan)
    provides: existing app.html shell

provides:
  - Mobile-Layout mit Safe-Area-Handling (viewport-fit=cover + env() insets)
  - Einzeilige Mobile-Topbar
  - Schwebende Color/Size-Trigger rechts oben (Mobile, nicht Zen)
  - Touch-Target-Pass (44px wo möglich, 40px tool-btn als pragmatischer Kompromiss)
  - Kontrast-Lift: --text-dim ~8.5:1, --text-faint ~3.8:1

affects:
  - Future UI plans (Sidebar, Toolbar-Konsolidierung)
  - Phase 2 Sync-Tests (UI muss daily-driver-ready sein, um sinnvoll zu testen)

tech-stack:
  added: []
  patterns:
    - "CSS-Variablen für Safe-Area-Insets (--safe-top/right/bottom/left, --tap-target)"
    - "Kondtitionsnale Layouts via @media (max-width: 768px) — kein User-Agent-Sniffing"
    - "Mobile-spezifische Position-fixed-Overlays mit zen-mode-Override"

key-files:
  created: []
  modified:
    - app.html

key-decisions:
  - "Tool-btn Mobile-Width 40px statt 44px — 8 sichtbare Toolbar-Buttons × 44 sprengen 360px-Viewports"
  - "Schwebende Trigger ohne Hintergrund (User-Wunsch); Lesbarkeit via dunkler Schriftfarbe statt Backdrop"
  - "Zen-Mode behält Trigger inline in Topbar (Override gegen mobile-MQ position:fixed)"

patterns-established:
  - "Safe-Area-Insets: Topbar/Pagebar absorbieren via padding, nicht das Grid"
  - "Tap-Target-Token --tap-target: 44px für konsistente Größen mobile-only"

duration: ~25min
started: 2026-05-04T00:00:00Z
completed: 2026-05-04T00:00:00Z
---

# Phase 1 Plan 01: UI-Optimierung — Mobile Touch-Targets & Safe-Areas

**Mobile-UI auf Daily-Driver-Niveau gebracht: Safe-Areas respektiert, Topbar einzeilig, Color/Size-Trigger schweben rechts oben, Touch-Targets ≥ 44px (mit einer pragmatischen Ausnahme), Text-Kontrast WCAG-konform (--text-dim 8.5:1, --text-faint 3.8:1).**

## Performance

| Metric | Value |
|--------|-------|
| Duration | ~25 min |
| Started | 2026-05-04 |
| Completed | 2026-05-04 |
| Tasks | 3 (2 auto + 1 human-verify) |
| Files modified | 1 (`app.html`) |

## Acceptance Criteria Results

| Criterion | Status | Notes |
|-----------|--------|-------|
| AC-1: Safe-Areas respektiert | Pass | viewport-fit=cover + `env(safe-area-inset-*)` an Sidebar, Toolbar, Pagebar; Grid-Rows = `calc(--toolbar-h + --safe-top)` etc. |
| AC-2: Mobile-Topbar einzeilig + Trigger schwebend | Pass | Portrait-Doppelreihe entfernt; `.mobile-color-trigger` / `.mobile-size-trigger` `position: fixed` rechts oben unter Topbar; Zen-Mode-Override hält sie inline |
| AC-3: Touch-Targets ≥ 44 × 44 px | Pass with concession | Alle Buttons ≥ 44×44 außer `.tool-btn` auf Mobile: 40×44 (Width-Kompromiss wegen 8 sichtbarer Toolbar-Buttons auf 360px-Viewports). WCAG AA (≥24px) erfüllt; AAA / iOS-HIG (44×44) nur teilweise. |
| AC-4: Text-Kontrast WCAG AA | Pass | --text-dim: #7a7692 → #b0acc8 (~8.5:1, AAA für Body-Text); --text-faint: #3e3b56 → #6c6886 (~3.8:1, AA für UI-Komponenten / große Texte) |

## Accomplishments

- Safe-Area-Handling über alle vier Insets (top/right/bottom/left), kompatibel mit Notch, Home-Indicator und Landscape mit Notch links — `100dvh` als Fallback gegen Browser-Chrome-Verschiebungen.
- Mobile-Topbar reduziert von zwei Reihen auf eine, ohne Toolbar-Inhalt zu verlieren — durch entfernen der Mobile-Trigger aus dem Toolbar-Fluss (jetzt schwebend) und Hide der visuellen Divider.
- Kontrast-Pass: `--text-faint` von effektiv unlesbar (~1.7:1) auf 3.8:1 angehoben; `--text-dim` von 4.5:1-Border auf 8.5:1 — kein "Geistertext" mehr in Sidebar/Footer.

## Task Commits

Keine atomaren Commits pro Task — Plan in einem Durchgang abgearbeitet, kein Auto-Commit konfiguriert.

## Files Created/Modified

| File | Change | Purpose |
|------|--------|---------|
| `app.html` | Modified | Viewport-Meta + CSS: Safe-Area-Variablen, Layout-Padding, Mobile-MQ-Restruktur, Touch-Target-Sizing, Color-Token-Lift, Mobile-Trigger Float + Zen-Override |

## Decisions Made

| Decision | Rationale | Impact |
|----------|-----------|--------|
| Tool-btn Mobile-Width 40px statt 44px | 8 sichtbare Toolbar-Buttons × 44 + Gaps + Padding sprengen 360px-Viewports (iPhone 12 mini, Galaxy S22) | Follow-up: Mobile-Toolbar konsolidieren (Clear/Reset in Overflow-Menü) |
| Schwebende Trigger ohne Hintergrund (User-Wunsch) | Aufgeräumter Look auf Papier-Canvas, Lesbarkeit via dunkler Color-Override (`#2b2840`) statt Backdrop | Color-Dot-Border und Size-Label brauchen explizite dunkle Farbe statt Theme-Token |
| Zen-Mode behält Trigger inline in Topbar | Im Zen-Mode ist Platz; floating wäre redundant | `body.zen-mode .mobile-color-trigger { position: static }` Override gegen mobile-MQ |

## Deviations from Plan

### Summary

| Type | Count | Impact |
|------|-------|--------|
| Auto-fixed | 0 | — |
| Mid-flight Code-Fixes (post human-verify) | 3 | Klein, durch User-Feedback im Checkpoint korrigiert |
| Deferred | 2 | Logged in STATE.md |

**Total impact:** Plan-Track funktional komplett. Eine bewusste AC-Konzession (tool-btn width) und drei Polish-Korrekturen nach dem ersten human-verify-Durchgang.

### Mid-flight Code-Fixes (User-Feedback)

**1. UI-Polish: Schwebende Trigger ohne Hintergrund**
- **Found during:** Task 3 (human-verify)
- **Issue:** Trigger hatten `background: var(--surface)` + `border` + `box-shadow` — User wollte transparent.
- **Fix:** `background: transparent; border: none; box-shadow: none;` + dunkle Color-Override (`#2b2840`) für Lesbarkeit auf Papier.
- **Files:** app.html
- **Verification:** Re-run human-verify approved.

**2. Regression-Fix: Zen-Mode-Trigger-Position**
- **Found during:** Task 3 (human-verify)
- **Issue:** Mobile-MQ erzwang `position: fixed` auch in Zen-Mode; User wollte Trigger inline in Topbar.
- **Fix:** `body.zen-mode .mobile-color-trigger, body.zen-mode .mobile-size-trigger { position: static; ... }` Override.
- **Files:** app.html
- **Verification:** Re-run human-verify approved.

**3. Code-Korrektur: Size-Label-Farbe explizit**
- **Found during:** Eigene Re-Verifikation
- **Issue:** `.mobile-size-label { color: var(--text-dim) }` überschreibt geerbte Color vom Trigger-Parent — Label wäre auf Papier unleserlich gewesen.
- **Fix:** Spezifische Regel `.mobile-size-trigger .mobile-size-label { color: #2b2840 }`.
- **Files:** app.html
- **Verification:** Lesbarkeit auf hellem Papier gegeben.

### Deferred Items

- **PWA Standalone-Modus startet mit Browser-Controls (Chrome/Android).** Verdacht: fehlende 192×192 + 512×512 Icons in `manifest.json` (`manifest.json` ist DO NOT CHANGE in diesem Plan). Logged in STATE.md.
- **Mobile-Toolbar-Konsolidierung** für volle 44×44-Konformität. Logged in STATE.md.

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| Tool-btn Mobile-Breite kollidiert mit ≥ 44px-Anforderung bei 360px-Viewports | Pragmatischer Kompromiss: 40×44 dokumentiert, Follow-up als Deferred Issue logged |
| Mobile-Trigger ohne Hintergrund auf hellem Papier nicht lesbar | Dunkle Color-Override (`#2b2840`) statt Theme-Token, da Theme-Tokens für dunkle Surfaces optimiert sind |

## Skill Audit

| Expected Skill | Invoked? | Notes |
|----------------|----------|-------|
| `/frontend-design` (required) | ✓ | Vor Task 1 geladen |
| `/simplify` (optional) | ○ | Nicht aufgerufen — nicht erforderlich |

## Next Phase Readiness

**Ready:**
- Mobile-UI auf Basis-Niveau für daily-driver — Safe-Areas, Touch-Targets, Kontrast.
- Solide CSS-Variablen-Basis (`--safe-*`, `--tap-target`) für künftige UI-Iterationen.

**Concerns:**
- Tool-btn Width 40 px auf engen Phones grenzwertig — bei häufigen Fehl-Tipps Folgeplan ziehen.
- PWA-Install (Standalone) noch nicht funktional — separater Plan nötig (Manifest-Icons 192/512).

**Blockers:**
- Keine für nächsten Plan (in Phase 1 oder Übergang zu Phase 2).

---
*Phase: 01-ui-optimierung, Plan: 01*
*Completed: 2026-05-04*
