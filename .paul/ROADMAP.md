# Roadmap: Notizbuch

## Overview

Offline-first PWA für handschriftliche Notizen mit E2E-verschlüsselter P2P-Synchronisation. Kernfunktionalität ist implementiert; die kommende Arbeit fokussiert UI-Refinement und Edge-Case-Härtung der Sync-Layer.

## Current Milestone

**v0.1 Daily-Driver Readiness**
Status: In progress
Phases: 0 of TBD complete

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with [INSERTED])

| Phase | Name | Plans | Status | Completed |
|-------|------|-------|--------|-----------|
| 1 | UI-Optimierung | 1+ (TBD) | Planning | - |
| 2 | Sync Edge-Cases (Mobile↔Desktop) | TBD | Not started | - |

## Phase Details

### Phase 1: UI-Optimierung

**Goal:** UI auf Daily-Driver-Niveau bringen — Mobile-tauglich, kontrastreich, aufgeräumt.
**Depends on:** Nothing (first phase)
**Research:** Unlikely (interne Patterns / CSS)

**Scope:**
- Mobile Touch-Targets & Safe-Areas
- Lesbarkeit / Kontrast
- Topbar-Layout & schwebende Mobile-Tools
- Weitere UI-Pässe nach Bedarf

**Plans:**
- [x] 01-01: Mobile Touch-Targets, Safe-Areas, einzeilige Topbar, Kontrast-Pass
- [x] 01-02: PWA Install Fix (Manifest-Icons 192/512, SW-Cache-Bump)
- [ ] 01-03: Zen-Mode-Layout-Fix (margin-left:auto-Override, padding-top:0, Gap-Reduktion)

### Phase 2: Sync Edge-Cases (Mobile↔Desktop)

**Goal:** Sync-Konvergenz auf realen Geräten verifizieren und Edge-Cases härten.
**Depends on:** Phase 1 (Mobile-UI muss benutzbar sein, um Sync-Tests sinnvoll durchzuführen)
**Research:** Unlikely

**Scope:**
- Wird in `/paul:plan` definiert.

---
*Roadmap created: 2026-05-04*
*Last updated: 2026-05-04*
