# Notizbuch

## What This Is

Offline-first Progressive Web App für handschriftliche Notizen mit Ende-zu-Ende-verschlüsselter P2P-Synchronisation über WebRTC. Strokes werden lokal gerendert (Canvas), lokal gespeichert (OPFS) und nur als Ciphertext über das Netz transportiert.

## Core Value

Privatsphäre für handschriftliche Notizen — kein Server vertraut Inhalte.

## Current State

| Attribute | Value |
|-----------|-------|
| Type | Application (PWA) |
| Version | 0.0.0 |
| Status | MVP (daily-driver in Erprobung) |
| Last Updated | 2026-05-04 |

## Requirements

### Core Features

- Notizbücher + Seiten anlegen, umbenennen, löschen
- Handschriftliche Strokes zeichnen (Stift, Radierer, Pan/Zoom)
- E2E-verschlüsselte Sync zwischen eigenen Geräten via MasterKey-Link
- Einzelne Notizbücher teilen (per-notebook Key, Invite-Link)
- Export / Import verschlüsselter Bundles (passphrase-geschützt)

### Validated (Shipped)

- [x] Notebook- und Page-Management
- [x] Canvas-Rendering mit Catmull-Rom Smoothing, 3-Layer-Architektur
- [x] OPFS-Storage mit IndexedDB-Fallback
- [x] AES-GCM 256 E2E-Verschlüsselung
- [x] Trystero P2P Multi-Room (Main + Shared Notebooks)
- [x] WebSocket Relay als Backup-Snapshot-Store (Plesk)
- [x] Pen-only-Mode Toggle
- [x] Shared Notebook Live-Sync via P2P (Multi-Room)
- [x] Fetch-Merge-Push für Shared-Notebook-Persistenz

### Active (In Progress)

- [ ] UI-Optimierung — aufgeräumter, intuitiver
- [ ] Edge-Case Testing Mobile ↔ Desktop Sync

### Planned (Next)

Wird in `/paul:plan` definiert.

### Out of Scope

- Eigener Nostr-Relay (öffentliche Relays reichen für Signaling)
- Server-seitige Plaintext-Verarbeitung jeglicher Art
- Swipe-Gestures für Page-Navigation (bewusst entfernt)

## Target Users

**Primary:** Personen, die handschriftliche Notizen über mehrere Geräte hinweg führen und keinem Cloud-Anbieter den Inhalt anvertrauen wollen.

- Nutzen Tablet (Stift) + Desktop / Phone parallel
- Wollen offline arbeiten können
- Wert legen auf Datenhoheit

## Context

**Technical Context:**
Single-Page-PWA, statisch ausgeliefert. Kein Build-Step. Drei unabhängige Sync-Layer (Nostr-Signaling, WebRTC P2P, WebSocket-Relay-Backup). Schlüssel-Hierarchie: MasterKey → Notebook-Keys; SHA-256-Hashes als Room-IDs.

## Constraints

### Technical Constraints

- Kein Build-Step / kein Bundler — vendored Libs only
- Firefox + OPFS: `SecurityError` → IndexedDB-Fallback
- Öffentliche Nostr-Relays gehen periodisch offline → Liste in `p2p-sync.js` muss gelegentlich gepflegt werden (Trystero braucht nur einen funktionierenden Relay)
- Plesk: Nginx-Proxy muss für WS-Upgrade deaktiviert sein
- mkcert-Zertifikat muss bei LAN-IP-Wechsel neu generiert werden

### Business Constraints

- Solo-Projekt, keine harten Deadlines

### Compliance Constraints

- Keine externen — Privacy-by-Design ist Selbstanforderung

## Key Decisions

| Decision | Rationale | Date | Status |
|----------|-----------|------|--------|
| Kein Build-Step | Wartbarkeit, Transparenz, einfaches Static-Hosting | 2025 | Active |
| Nostr nur fürs Signaling, eigener Relay nur für Backup | Kein Vertrauen in Server für Plaintext | 2025 | Active |
| Trystero Multi-Room (Main + per Shared Notebook) | Live-Sync für Shared Notebooks ohne globale Broadcasts | 2026 | Active |

## Success Metrics

| Metric | Target | Current | Status |
|--------|--------|---------|--------|
| Daily-driver-ready Mobile + Desktop | Stabil über Wochen | In Erprobung | On track |
| UI aufgeräumt | Subjektiv "intuitiv" | Optimierung steht an | Active |
| Sync konvergent | Keine Datenverluste über alle Layer | Edge-Cases offen | At risk (Mobile↔Desktop Tests offen) |

## Tech Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| Frontend | Vanilla JS + HTML5 Canvas | 3-Layer (bg / static / active), kein Framework |
| Storage | OPFS (primär), IndexedDB (Fallback) | Settings in IndexedDB `notizbuch-settings` |
| Encryption | Web Crypto API (AES-GCM 256) | MasterKey + per-Notebook Keys |
| Signaling | Nostr Public Relays | Trystero braucht nur einen erreichbaren Relay |
| P2P Sync | Trystero (WebRTC) | Multi-Room: Main (masterKeyHash) + Shared (notebookHash) |
| Relay (Backup) | Node.js WebSocket on Plesk | Encrypted Blob Storage, 30-Tage TTL, kein Broadcast |
| PWA | Service Worker + manifest.json | network-first HTML, stale-while-revalidate libs |
| Dev Server | Node.js HTTPS + WSS (relay/) | mkcert für LAN-Tests |

## Specialized Flows

See: .paul/SPECIAL-FLOWS.md

Quick Reference:
- `/frontend-design` → UI components & layout work
- `/simplify` → Code-Refactor + Cleanup (optional)
- `/feature-dev:feature-dev` → Neue Features mit Codebase-Kontext

## Links

| Resource | URL |
|----------|-----|
| Production Relay | wss://notes.mike.fm-media-staging.at |

---
*PROJECT.md — Updated when requirements or context change*
*Last updated: 2026-05-04*
