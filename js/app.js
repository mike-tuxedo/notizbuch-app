// app.js — Notizbuch Hauptlogik
// State-Management, Init, Canvas-Steuerung, Input-Handling, Navigation.
// Importiert Module für Storage, Canvas-Engine, P2P, Encryption.

import { initStorage, savePageData, loadPageData, deletePageData, deleteNotebookData, saveMeta, loadMeta, clearAll } from './storage.js';
import {
  roundPoints, drawStrokeToCanvas, drawBackground,
  SHAPE_TYPES, isValidShape, roundShape, shapeOutlinePoints, shapeToSvg,
  isValidFill, fillOutlinePoints, fillToSvg, traceFillRegion, simplifyRing,
  isValidTransform, transformStroke, strokeGeomBounds, hitTestStroke
} from './canvas.js';
import {
  initP2P, send as p2pSend, sendToAll as p2pSendToAll,
  joinSharedRoom, leaveSharedRoom, leaveRoom,
  isConnected, hasPeers,
  setIceSettings, getIceStatus, getPeerDiagnostics
} from './p2p-sync.js';
import { generateKey, exportKey, importKey, encrypt, decrypt } from './encryption.js';
import { packBackup, unpackBackup } from './share.js';
import {
  initRelay, closeRelay, putBlob as relayPut, deleteBlob as relayDelete, isRelayConnected, fetchRoom, pushBlobsToRoom,
  setRelayUrl, getCustomRelayUrl, defaultRelayUrl, isValidRelayUrl, relayUrlProblem,
  openLiveChannel, closeLiveChannel, closeAllLiveChannels, sendLiveEvent, reconnectLiveChannels, liveChannelStatus
} from './relay.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** @type {number} DPR gekappt auf 2 für Performance */
const DPR = Math.min(window.devicePixelRatio || 1, 2);

/** @type {Array<string>} Standard-Farbpalette (ohne Weiß — das Papier ist immer weiß) */
const COLORS = ['#14171c', '#868e96', '#e03131', '#f08c00', '#f2c200', '#2f9e44', '#0c8599', '#1971c2', '#6741d9'];
/** @type {Array<string>} Namen zur Palette (für aria-label/title) */
const COLOR_NAMES = ['Schwarz', 'Grau', 'Rot', 'Orange', 'Gelb', 'Grün', 'Türkis', 'Blau', 'Violett'];

/** @type {Array<{name: string, label: string, size: number, dot: number}>} Stiftgrößen (dot = Punktgröße in der Auswahl) */
const PEN_SIZES = [
  { name: 'XS', label: 'Fein', size: 1, dot: 4 },
  { name: 'S', label: 'Dünn', size: 2, dot: 7 },
  { name: 'M', label: 'Mittel', size: 4, dot: 11 },
  { name: 'L', label: 'Dick', size: 8, dot: 16 },
  { name: 'XL', label: 'Sehr dick', size: 16, dot: 24 }
];

const APP_VERSION = '2026-11-21-select-v49';
const PRESENCE_INTERVAL_MS = 5000;
const PRESENCE_TIMEOUT_MS = 15000;

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {Object} Globaler App-State */
const state = {
  /** @type {Array<{id: string, name: string, pages: Array}>} */
  notebooks: [],
  /** @type {string|null} */
  currentNotebookId: null,
  /** @type {Object<string, string|null>} notebookId → pageId */
  currentPageIds: {},

  // Tools
  tool: 'pen',        // 'pen' | 'eraser' | 'fill' | 'shape' | 'select' | 'hand' (hand = Bewegen-Schalter an)
  shapeType: 'rect',  // Form des Werkzeugs „Formen“: 'rect' | 'ellipse' | 'line' | 'arrow'
  lastDrawTool: 'pen', // zuletzt benutztes Zeichenwerkzeug — kommt zurück, wenn die Hand ausgeht
  color: '#14171c',
  penSizeIndex: 2,
  customColors: [],
  penDetected: false,
  penOnlyMode: false,

  // View
  viewScale: 1,
  viewX: 0,
  viewY: 0,

  // Sync
  syncEnabled: true,
  connectedPeers: [],
  deviceId: null,
  hostByNotebook: {},
  presenceByNotebook: {},
  eventSeq: 0,
  /** @type {string|null} Hex-Hash des MasterKeys — bestimmt Room-ID */
  masterKeyHash: null,
  /** @type {Object<string, CryptoKey>} notebookId → NotebookKey (für OPFS-Verschlüsselung) */
  notebookKeys: {},
  /** @type {Set<string>} IDs der geteilten Notebooks (Relay-Sync über notebookHash) */
  sharedNotebooks: new Set(),

  // UI
  zenMode: false,
};

// ─── DOM References ─────────────────────────────────────────────────────────

/** @type {HTMLCanvasElement} */
let bgCanvas, staticCanvas, activeCanvas;
/** @type {CanvasRenderingContext2D} */
let bgCtx, staticCtx, activeCtx;
/** @type {HTMLCanvasElement|null} Bitmap-Cache für Pan/Zoom */
let strokeCacheCanvas = null;
let cacheViewX = 0, cacheViewY = 0, cacheViewScale = 1;

// ─── Drawing State ──────────────────────────────────────────────────────────

let isDrawing = false;
let currentPoints = [];
let lastPoint = null;
let activePointerId = null;
let activePointerType = null;

// ─── Pinch/Zoom State (outside reactive for performance) ────────────────────

const pinchState = {
  touches: {}, active: false,
  startViewX: 0, startViewY: 0, startScale: 1,
  startMidX: 0, startMidY: 0, startDist: 1
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** @returns {{id: string, name: string, pages: Array}|undefined} */
function currentNotebook() {
  return state.notebooks.find(n => n.id === state.currentNotebookId);
}

function newId() {
  return crypto.randomUUID();
}

function comparePageOrder(a, b) {
  const ao = Number.isFinite(a?.order) ? a.order : 0;
  const bo = Number.isFinite(b?.order) ? b.order : 0;
  if (ao !== bo) return ao - bo;
  const ac = Number.isFinite(a?.createdAt) ? a.createdAt : 0;
  const bc = Number.isFinite(b?.createdAt) ? b.createdAt : 0;
  if (ac !== bc) return ac - bc;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function normalizePageOrder(nb) {
  if (!nb?.pages) return;
  nb.pages.sort(comparePageOrder);
  nb.pages.forEach((p, i) => { p.order = i; });
}

function ensureCurrentPageId(notebookId = state.currentNotebookId) {
  const nb = state.notebooks.find(n => n.id === notebookId);
  if (!nb?.pages?.length) {
    state.currentPageIds[notebookId] = null;
    return null;
  }
  const currentId = state.currentPageIds[notebookId];
  const idx = currentId ? nb.pages.findIndex(p => p.id === currentId) : -1;
  if (idx >= 0 && !isPageGone(nb.pages[idx])) return currentId;
  // Gemerkte Seite fehlt oder ist gelöscht: nächste sichtbare Nachbarseite (erst dahinter, dann davor).
  // Gibt es keine sichtbare Seite, bleibt es bei der gemerkten — ensureVisiblePage() legt dann eine an.
  const shown = p => !isPageGone(p);
  const fallback = (idx >= 0
    ? (nb.pages.slice(idx + 1).find(shown) || nb.pages.slice(0, idx).reverse().find(shown) || nb.pages[idx])
    : nb.pages.find(shown)) || nb.pages[0];
  state.currentPageIds[notebookId] = fallback.id;
  return fallback.id;
}

/**
 * Gelöscht ist eine Seite genau dann, wenn deletedAt > restoredAt. Beide Felder werden
 * zwischen Geräten per Maximum gemischt — so lässt sich ein Löschen wieder aufheben.
 */
function isPageDeleted(page = currentPage()) {
  return !!page && (page.deletedAt || 0) > (page.restoredAt || 0);
}

/** Seiten für Navigation und Zähler: ohne gelöschte und zum Löschen vorgemerkte. */
function visiblePages(nb = currentNotebook()) {
  return (nb?.pages || []).filter(p => !isPageGone(p));
}

/**
 * Vorgemerktes „Seite leeren“ / „Seite löschen“ (Hinweis mit „Rückgängig“ läuft noch).
 * Wirkt nur in der Anzeige dieses Geräts: page.clearedAt / page.deletedAt bleiben bis zum
 * Festschreiben unverändert, deshalb geht in der Frist nichts davon in Speicher oder Sync.
 * @type {{kind: 'clear'|'delete', notebookId: string, pageId: string, at: number, toast: {dismiss: Function}|null}|null}
 */
let _pendingPageOp = null;

/** Zeitpunkt eines vorgemerkten Leerens dieser Seite (0 = keins). */
function pendingClearAt(page) {
  const op = _pendingPageOp;
  return op && op.kind === 'clear' && page && op.pageId === page.id ? op.at : 0;
}

function isPendingDelete(page) {
  const op = _pendingPageOp;
  return !!(op && op.kind === 'delete' && page && op.pageId === page.id);
}

/** Für die Bedienung: gelöscht oder zum Löschen vorgemerkt. Sync-Eingänge prüfen weiter isPageDeleted(). */
function isPageGone(page = currentPage()) {
  return isPageDeleted(page) || isPendingDelete(page);
}

function strokeCreatedAt(stroke) {
  if (Number.isFinite(stroke?.createdAt)) return stroke.createdAt;
  const ts = Number(stroke?.id);
  return Number.isFinite(ts) ? ts : 0;
}

function ensurePageEvents(page) {
  if (Array.isArray(page.events)) return page.events;
  const legacyStrokes = Array.isArray(page.strokes) ? page.strokes : [];
  page.events = legacyStrokes.map((stroke, i) => ({
    id: `legacy:${stroke.id || i}`,
    type: 'stroke',
    createdAt: strokeCreatedAt(stroke),
    deviceId: stroke.deviceId || 'legacy',
    seq: i,
    stroke
  }));
  return page.events;
}

function sortPageEvents(events = []) {
  return [...events].sort((a, b) => {
    const ta = Number(a?.createdAt) || 0;
    const tb = Number(b?.createdAt) || 0;
    if (ta !== tb) return ta - tb;
    const da = String(a?.deviceId || '');
    const db = String(b?.deviceId || '');
    if (da !== db) return da.localeCompare(db);
    return (Number(a?.seq) || 0) - (Number(b?.seq) || 0);
  });
}

function newPageEvent(type, payload = {}) {
  state.eventSeq = (state.eventSeq || 0) + 1;
  return {
    id: `${state.deviceId || 'device'}:${state.eventSeq}:${Date.now()}`,
    type,
    createdAt: Date.now(),
    deviceId: state.deviceId || 'device',
    seq: state.eventSeq,
    ...payload
  };
}

/** Felder, die ein edit-Event ändern darf. Reihenfolge = Reihenfolge der Anwendung (shape vor transform). */
const EDIT_FIELDS = ['shape', 'transform', 'color', 'fill', 'size'];

/** Nur gültige Werte eines edit-Patches übernehmen (Events kommen auch von anderen Geräten). */
function editFieldValue(field, value) {
  if (field === 'shape') {
    // Neue Grundgeometrie einer Form (Endpunkt-Griffe): vier endliche Koordinaten, der Typ bleibt der des Objekts
    if (!value || typeof value !== 'object') return undefined;
    const { x1, y1, x2, y2 } = value;
    return [x1, y1, x2, y2].every(Number.isFinite) ? { x1, y1, x2, y2 } : undefined;
  }
  if (field === 'transform') return isValidTransform(value) ? value : undefined;
  if (field === 'color') return typeof value === 'string' && value ? value : undefined;
  if (field === 'fill') return value === null || (typeof value === 'string' && value) ? value : undefined;
  if (field === 'size') return Number.isFinite(value) && value > 0 ? value : undefined;
  return undefined;
}

/**
 * Fertiges Objekt aus Ursprungs-Strich und zusammengeführtem Patch (neues Objekt, der Ursprung
 * bleibt unverändert). patch.shape ersetzt bei Formen die Grundgeometrie; transform bildet danach
 * diese Grundgeometrie ab (ohne patch.shape die URSPRÜNGLICHE).
 */
function applyStrokePatch(base, patch) {
  if (!patch) return base;
  let out = { ...base };
  if (patch.shape && out.tool === 'shape' && isValidShape(out.shape)) {
    out.shape = roundShape({ ...patch.shape, type: out.shape.type });
    if (!patch.transform) out.points = shapeOutlinePoints(out.shape, patch.size !== undefined ? patch.size : out.size);
  }
  if (patch.color !== undefined) out.color = patch.color;
  if (patch.size !== undefined) out.size = patch.size;
  if (patch.fill !== undefined && out.tool === 'shape' && (out.shape?.type === 'rect' || out.shape?.type === 'ellipse')) out.fill = patch.fill;
  if (patch.transform) out = transformStroke(out, patch.transform);
  else if (patch.size !== undefined && out.tool === 'shape' && out.shape) out.points = shapeOutlinePoints(out.shape, out.size);
  return out;
}

/**
 * Seite aus dem Event-Log aufbauen — mit allem, was Auswahl und Rückgängig dazu wissen müssen.
 *  - stroke: Objekt (Stift, Radierer, Form, Füllfläche), sichtbar ab clearedAt
 *  - undo mit targetStrokeId: blendet das Objekt aus (reason:'delete' = über die Auswahl gelöscht)
 *  - undo mit targetEventId: hebt ein edit-Event auf
 *  - redo mit targetEventId: hebt ein undo-Event auf (beide Arten)
 *  - edit: ändert Felder eines Objekts; pro Feld gilt der letzte nicht aufgehobene edit
 *    (Reihenfolge wie sortPageEvents) — unabhängig von der Ankunftsreihenfolge
 * @returns {{strokes: Array, baseById: Map, strokeEvents: Map, patches: Map, effectiveEdits: Array, effectiveDeletes: Array}}
 */
function materializePageDetailed(page) {
  ensurePageEvents(page);
  // Ein vorgemerktes Leeren blendet lokal schon aus, steht aber noch nicht in page.clearedAt
  const clearedAt = Math.max(page?.clearedAt || 0, pendingClearAt(page));
  const undoneStrokeIds = new Map(); // strokeId → Anzahl wirksamer Undos
  const undoneEditIds = new Set();
  const base = [];
  const baseById = new Map();
  const strokeEvents = new Map(); // strokeId → stroke-Event (für groupId)
  const edits = [];
  const deletes = [];
  // Erster Durchlauf: aufgehobene Undo-Events sammeln. Ein Redo-Event hebt genau
  // ein Undo-Event auf (targetEventId) — unabhängig von der Reihenfolge im Log.
  const redoneUndoIds = new Set();
  for (const event of page.events || []) {
    if (event?.type === 'redo' && event.targetEventId) redoneUndoIds.add(event.targetEventId);
  }
  for (const event of sortPageEvents(page.events || [])) {
    if (event.type === 'stroke' && event.stroke) {
      // Striche vor dem letzten Clear bleiben ausgeblendet
      if ((Number(event?.createdAt) || 0) <= clearedAt) continue;
      // Doppelte stroke.id absichern (z.B. legacy/import/device-Duplikat)
      if (baseById.has(event.stroke.id)) continue;
      baseById.set(event.stroke.id, event.stroke);
      strokeEvents.set(event.stroke.id, event);
      base.push(event.stroke);
    } else if (event.type === 'undo') {
      // Undo-Events wirken unabhängig von ihrer Reihenfolge und dürfen
      // nicht durch die clearedAt-Prüfung verloren gehen.
      // Ein per Redo aufgehobenes Undo wirkt nicht mehr.
      if (redoneUndoIds.has(event.id)) continue;
      if (event.targetStrokeId) {
        undoneStrokeIds.set(event.targetStrokeId, (undoneStrokeIds.get(event.targetStrokeId) || 0) + 1);
        if (event.reason === 'delete') deletes.push(event);
      } else if (event.targetEventId) {
        undoneEditIds.add(event.targetEventId);
      }
    } else if (event.type === 'edit' && event.targetStrokeId && event.patch && typeof event.patch === 'object') {
      edits.push(event);
    }
  }
  const visible = base.filter(s => !undoneStrokeIds.has(s.id));
  const visibleIds = new Set(visible.map(s => s.id));
  // edits in Sortierreihenfolge: der spätere überschreibt pro Feld den früheren
  const patches = new Map();
  const effectiveEdits = [];
  for (const event of edits) {
    if (undoneEditIds.has(event.id) || !visibleIds.has(event.targetStrokeId)) continue;
    let patch = patches.get(event.targetStrokeId);
    let used = false;
    for (const field of EDIT_FIELDS) {
      if (!(field in event.patch)) continue;
      // patch.shape gilt nur für Formen
      if (field === 'shape' && baseById.get(event.targetStrokeId)?.tool !== 'shape') continue;
      const value = editFieldValue(field, event.patch[field]);
      if (value === undefined) continue;
      if (!patch) { patch = {}; patches.set(event.targetStrokeId, patch); }
      patch[field] = value;
      used = true;
    }
    if (used) effectiveEdits.push(event);
  }
  return {
    strokes: visible.map(s => applyStrokePatch(s, patches.get(s.id))),
    baseById,
    strokeEvents,
    patches,
    effectiveEdits,
    // Wirksames Löschen: das Objekt gäbe es noch, und nur dieses eine Event blendet es aus
    effectiveDeletes: deletes.filter(e => baseById.has(e.targetStrokeId) && undoneStrokeIds.get(e.targetStrokeId) === 1)
  };
}

/** Sichtbare, fertige Objekte der Seite (Geometrie inkl. transform, Farbe, Füllung). */
function materializePage(page) {
  return materializePageDetailed(page).strokes;
}

/**
 * „Letzte Aktion“ der Seite — das, was Rückgängig als Nächstes zurücknimmt. Aktionen sind:
 *  - ein sichtbares Objekt (stroke-Event), Zeit = createdAt des Strichs
 *  - ein wirksames edit-Event (nicht aufgehoben, Ziel sichtbar), Zeit = createdAt des Events
 *  - ein wirksames Löschen über die Auswahl (undo-Event mit reason:'delete'), Zeit = createdAt des Events
 * Es gewinnt die späteste Zeit; bei Gleichstand Löschen/edit vor Strich, sonst deviceId, seq.
 * Ein gewöhnliches Rückgängig (undo ohne reason) und redo sind selbst keine Aktionen.
 * Trägt das Event der letzten Aktion eine groupId (Mehrfachauswahl), gehören alle noch wirksamen
 * Events mit derselben groupId dazu — die Gruppe ist EINE Aktion.
 * @returns {{kind: 'stroke', stroke: Object}|{kind: 'edit'|'delete', event: Object}|{kind: 'group', groupId: string, members: Array}|null}
 */
function lastPageAction(page) {
  const det = materializePageDetailed(page);
  const candidates = [];
  const sorted = [...det.strokes].sort((a, b) => strokeCreatedAt(a) - strokeCreatedAt(b) || String(a.id).localeCompare(String(b.id)));
  const lastStroke = sorted[sorted.length - 1];
  if (lastStroke) candidates.push({ kind: 'stroke', stroke: lastStroke, time: strokeCreatedAt(lastStroke), rank: 0, deviceId: '', seq: 0 });
  for (const [kind, list] of [['edit', det.effectiveEdits], ['delete', det.effectiveDeletes]]) {
    const event = list[list.length - 1];
    if (event) candidates.push({ kind, event, time: Number(event.createdAt) || 0, rank: 1, deviceId: String(event.deviceId || ''), seq: Number(event.seq) || 0 });
  }
  candidates.sort((a, b) => a.time - b.time || a.rank - b.rank || a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq);
  const last = candidates[candidates.length - 1] || null;
  if (!last) return null;
  const groupId = last.kind === 'stroke' ? det.strokeEvents.get(last.stroke.id)?.groupId : last.event.groupId;
  if (!groupId) return last;
  // Kommt von einer Gruppe erst ein Teil an, besteht sie vorerst aus dem, was da ist
  const members = [];
  for (const stroke of det.strokes) if (det.strokeEvents.get(stroke.id)?.groupId === groupId) members.push({ kind: 'stroke', stroke });
  for (const event of det.effectiveEdits) if (event.groupId === groupId) members.push({ kind: 'edit', event });
  for (const event of det.effectiveDeletes) if (event.groupId === groupId) members.push({ kind: 'delete', event });
  return members.length > 1 ? { kind: 'group', groupId, members } : last;
}

function refreshPageMaterializedState(page) {
  page.strokes = materializePage(page).sort((a, b) => strokeCreatedAt(a) - strokeCreatedAt(b) || String(a.id).localeCompare(String(b.id)));
  return page.strokes;
}

function applyPageEvent(page, event) {
  ensurePageEvents(page);
  if (!event?.id) return false;
  if (page.events.some(e => e.id === event.id)) return false;
  page.events.push(event);
  refreshPageMaterializedState(page);
  return true;
}

/** Mehrere eigene Events auf einmal anhängen (Gruppenaktion) — die Seite wird nur einmal neu aufgebaut. */
function applyPageEvents(page, events) {
  ensurePageEvents(page);
  const known = new Set(page.events.map(e => e.id));
  let changed = false;
  for (const event of events) {
    if (!event?.id || known.has(event.id)) continue;
    known.add(event.id);
    page.events.push(event);
    changed = true;
  }
  if (changed) refreshPageMaterializedState(page);
  return changed;
}

/**
 * Events aus Remote-Quellen in eine Seite vereinigen.
 * - Überspringt bereits bekannte Event-IDs.
 * - Überspringt stroke-Events, wenn dieselbe stroke.id bereits existiert
 *   (z.B. legacy:/import:/device-Event für denselben Strich).
 * - Materialisiert die Seite neu, wenn sich etwas geändert hat.
 * @returns {boolean} true wenn neue Events hinzugefügt wurden
 */
function mergePageEvents(page, events = []) {
  ensurePageEvents(page);
  let changed = false;
  const knownEventIds = new Set(page.events.map(e => e.id));
  const knownStrokeIds = new Set(page.events.filter(e => e.type === 'stroke' && e.stroke?.id).map(e => e.stroke.id));
  for (const event of events) {
    if (!event?.id || knownEventIds.has(event.id)) continue;
    if (event.type === 'stroke' && event.stroke?.id) {
      if (knownStrokeIds.has(event.stroke.id)) continue;
      knownStrokeIds.add(event.stroke.id);
    }
    page.events.push(event);
    knownEventIds.add(event.id);
    changed = true;
  }
  if (changed) refreshPageMaterializedState(page);
  return changed;
}

const _seenSyncEvents = new Set();

function newEventId() {
  return `${Date.now()}-${newId()}`;
}

function rememberSyncEvent(eventId) {
  if (!eventId) return false;
  if (_seenSyncEvents.has(eventId)) return true;
  _seenSyncEvents.add(eventId);
  if (_seenSyncEvents.size > 2000) {
    const first = _seenSyncEvents.values().next().value;
    if (first) _seenSyncEvents.delete(first);
  }
  return false;
}

/**
 * Empfangenes Event an alle anderen weiterreichen (Teilnetze: nicht jeder Peer
 * ist mit jedem verbunden). Wird pro eventId genau einmal aufgerufen.
 *
 * Wichtig: Ein Notizbuch lebt in bis zu zwei Rooms — Haupt-Room (eigene Geräte)
 * und Shared-Room (andere Personen). Ein Event, das über den einen Room ankommt,
 * muss auch in den anderen, sonst erreicht z.B. der Strich eines eigenen Geräts
 * nie den Gast, der nur im Shared-Room ist (und umgekehrt).
 */
function forwardSyncEvent(action, data, roomId, fromPeerId) {
  if (!roomId) return;
  if (!data?.eventId) return;
  // Herkunfts-Room: unverändert weiterreichen
  syncSend(action, data, { roomId, noRelay: true });
  // Nur seitenbezogene Events wechseln den Room (full-sync bleibt im eigenen)
  if (action !== 'stroke' && action !== 'undo' && action !== 'redo' && action !== 'edit' && action !== 'batch') return;
  const localNbId = _resolveNbId(data.notebookId, roomId);
  if (!localNbId || !state.notebooks.some(n => n.id === localNbId)) return;
  const fromMain = roomId === state.masterKeyHash;
  if (fromMain) {
    // Haupt-Room → Shared-Room (Empfänger lösen die Notizbuch-ID über den Room auf)
    const nbHash = state.sharedNotebooks.has(localNbId) ? _sharedRoomMap.get(localNbId) : null;
    if (nbHash) syncSend(action, data, { roomId: nbHash, noRelay: true });
  } else {
    // Shared-Room → Haupt-Room: eigene Geräte kennen nur UNSERE Notizbuch-ID
    syncSend(action, { ...data, notebookId: localNbId }, { roomId: state.masterKeyHash, noRelay: true });
  }
}

/** Action-Name zu Callback-Name wie in p2p-sync.js. */
function actionCallbackName(action) {
  return 'on' + action.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

/** Schlüssel für einen Room: Main = MasterKey, Shared = NotebookKey. */
async function _keyForRoom(roomId) {
  if (roomId === state.masterKeyHash) return getMasterCryptoKey();
  for (const [nbId, hash] of _sharedRoomMap) {
    if (hash === roomId) return getNotebookKey(nbId);
  }
  return null;
}

/**
 * Zentrale Sendefunktion für Sync-Events.
 * Versendet immer per P2P wie bisher und zusätzlich verschlüsselt über den
 * Relay-Live-Kanal, falls es sich um einen Broadcast handelt.
 */
function syncSend(action, data, opts = {}) {
  // P2P-Teil
  // Notizbuch-Meta (full-sync) trägt die ID im Notizbuch-Eintrag — ohne sie käme Seiten-Meta
  // (neu, geleert, gelöscht, wiederhergestellt) nie im Shared-Room an.
  const forNbId = opts.forNotebook ? (data.notebookId || data.id || data.notebooks?.[0]?.id) : null;
  if (opts.forNotebook) {
    p2pSend(action, data);
    const nbId = forNbId;
    if (nbId && state.sharedNotebooks.has(nbId)) {
      const nbHash = _sharedRoomMap.get(nbId);
      if (nbHash) p2pSend(action, data, { roomId: nbHash });
    }
  } else {
    p2pSend(action, data, opts);
  }

  // Ausgehende P2P-Aktivität protokollieren (außer Presence).
  if (!data?.__presence) markSyncActivity('send:' + action);

  // Relay-Teil: nur für Broadcasts ohne gezielten Peer, nicht explizit
  // abgeschaltet und nie für Presence-Pings.
  if (opts.peerId || opts.noRelay || data?.__presence) return;

  const rooms = [];
  if (opts.forNotebook) {
    rooms.push(state.masterKeyHash);
    const nbId = forNbId;
    if (nbId && state.sharedNotebooks.has(nbId)) {
      const nbHash = _sharedRoomMap.get(nbId);
      if (nbHash) rooms.push(nbHash);
    }
  } else {
    rooms.push(opts.roomId || state.masterKeyHash);
  }

  for (const roomId of rooms) {
    sendRelayEvent(action, data, roomId);
  }
}

/** Einzelnes Event über den Relay-Live-Kanal verschlüsselt senden. */
async function sendRelayEvent(action, data, roomId) {
  if (!roomId) return;
  const key = await _keyForRoom(roomId);
  if (!key) return;
  const envelope = JSON.stringify({ a: action, d: data });
  const plain = new TextEncoder().encode(envelope);
  let cipher;
  try { cipher = await encrypt(key, plain); } catch { return; }
  const ok = sendLiveEvent(roomId, cipher);
  if (ok) markSyncActivity('send:relay:' + action);
}

/** Eingehendes Relay-Live-Event entschlüsseln und an P2P-Handler weiterleiten. */
async function onLiveEvent(ciphertext, roomId) {
  try {
    const key = await _keyForRoom(roomId);
    if (!key) return;
    const plain = await decrypt(key, ciphertext);
    const envelope = JSON.parse(new TextDecoder().decode(plain));
    const { a: action, d: data } = envelope;
    const cbName = actionCallbackName(action);
    const handler = roomId === state.masterKeyHash ? _mainP2pCallbacks[cbName] : _p2pCallbacks[cbName];
    if (handler) {
      handler(data, 'relay', roomId);
      markSyncActivity('recv:relay:' + action);
    }
  } catch {
    // Fehler still verwerfen — Ciphertext kann von einem fremden Client stammen.
  }
}

/** Haupt-Live-Kanal öffnen (eigene Geräte). */
function openMainLiveChannel() {
  if (!state.masterKeyHash) return;
  openLiveChannel(state.masterKeyHash, onLiveEvent);
}

// Peer-Diagnosen (ICE-Typen) werden im Hintergrund aktualisiert,
// damit updateSyncDebug synchron bleibt.
let _peerDiagnostics = [];
let _peerDiagnosticsTimer = null;

function startPeerDiagnosticsTimer() {
  if (_peerDiagnosticsTimer) return;
  _peerDiagnosticsTimer = setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    if (!document.getElementById('console') || !isSyncDebugOn()) return;
    try { _peerDiagnostics = await getPeerDiagnostics(); } catch {}
    updateSyncDebug();
  }, 3000);
}

function pageMeta(page) {
  return {
    id: page.id,
    background: page.background || 'grid',
    order: page.order ?? 0,
    createdAt: page.createdAt || 0,
    clearedAt: page.clearedAt || 0,
    deletedAt: page.deletedAt || 0,
    // Zusatzfeld (ältere Versionen ignorieren es): Zeitpunkt des letzten Wiederherstellens
    restoredAt: page.restoredAt || 0
  };
}

function notebookMeta(notebook, opts = {}) {
  const includePageStrokes = opts.includePageStrokes ?? false;
  const currentId = state.currentPageIds[notebook.id];
  return {
    id: notebook.id,
    name: notebook.name,
    pages: notebook.pages.map(page => {
      const include = includePageStrokes || page.id === currentId;
      return {
        ...pageMeta(page),
        strokes: include
          ? (page.strokes || []).map(s => ({
              id: s.id, points: s.points, color: s.color, size: s.size, tool: s.tool, createdAt: strokeCreatedAt(s),
              ...(s.shape ? { shape: s.shape, fill: s.fill ?? null } : {}),
              ...(s.polys ? { polys: s.polys } : {})
            }))
          : [],
        events: include
          ? sortPageEvents(ensurePageEvents(page)).map(event => event.type === 'stroke' ? ({
              ...event,
              stroke: {
                ...event.stroke,
                points: roundPoints(event.stroke?.points || []),
                tool: event.stroke?.tool || 'pen',
                createdAt: strokeCreatedAt(event.stroke)
              }
            }) : event)
          : []
      };
    })
  };
}

function applyPageMeta(localPage, remotePage) {
  if (typeof remotePage.order === 'number') localPage.order = remotePage.order;
  if (remotePage.background) localPage.background = remotePage.background;
  if (!localPage.createdAt && remotePage.createdAt) localPage.createdAt = remotePage.createdAt;
  localPage.clearedAt = Math.max(localPage.clearedAt || 0, remotePage.clearedAt || 0);
  localPage.deletedAt = Math.max(localPage.deletedAt || 0, remotePage.deletedAt || 0);
  localPage.restoredAt = Math.max(localPage.restoredAt || 0, remotePage.restoredAt || 0);
}

function normalizePageStrokes(page, incomingStrokes = null) {
  ensurePageEvents(page);
  const known = new Set((page.events || []).filter(e => e.type === 'stroke' && e.stroke?.id).map(e => e.stroke.id));
  for (const stroke of (incomingStrokes || [])) {
    if (!stroke?.id || known.has(stroke.id)) continue;
    page.events.push({
      id: `import:${stroke.id}`,
      type: 'stroke',
      createdAt: strokeCreatedAt(stroke),
      deviceId: stroke.deviceId || 'import',
      seq: Number(stroke.seq) || 0,
      stroke
    });
    known.add(stroke.id);
  }
  return refreshPageMaterializedState(page);
}


function mergeNotebookMetaIntoState(remoteNb) {
  let localNb = state.notebooks.find(n => n.id === remoteNb.id);
  if (!localNb) {
    localNb = { id: remoteNb.id, name: remoteNb.name, pages: [] };
    state.notebooks.push(localNb);
  } else if (remoteNb.name) {
    localNb.name = remoteNb.name;
  }
  for (const remotePage of (remoteNb.pages || [])) {
    let localPage = localNb.pages.find(p => p.id === remotePage.id);
    if (!localPage) {
      localPage = { ...pageMeta(remotePage), strokes: remotePage.strokes || [] };
      localNb.pages.push(localPage);
    } else {
      applyPageMeta(localPage, remotePage);
    }
  }
  normalizePageOrder(localNb);
  ensureCurrentPageId(localNb.id);
  return localNb;
}

function ensureDeviceId() {
  let id = localStorage.getItem('notizbuch:deviceId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('notizbuch:deviceId', id);
  }
  state.deviceId = id;
  return id;
}

function prunePresence(notebookId) {
  const map = state.presenceByNotebook[notebookId] || {};
  const now = Date.now();
  for (const [deviceId, entry] of Object.entries(map)) {
    if (!entry?.lastSeen || now - entry.lastSeen > PRESENCE_TIMEOUT_MS) delete map[deviceId];
  }
  state.presenceByNotebook[notebookId] = map;
  return map;
}

function recomputeHost(notebookId) {
  const map = prunePresence(notebookId);
  const activeIds = Object.keys(map).sort();
  const prevHostId = state.hostByNotebook[notebookId] || null;
  const hostId = activeIds[0] || null;
  state.hostByNotebook[notebookId] = hostId;
  handleHostChange(notebookId, prevHostId, hostId);
  return hostId;
}

function upsertPresence(notebookId, deviceId, lastSeen = Date.now()) {
  if (!notebookId || !deviceId) return;
  if (!state.presenceByNotebook[notebookId]) state.presenceByNotebook[notebookId] = {};
  state.presenceByNotebook[notebookId][deviceId] = { lastSeen };
  recomputeHost(notebookId);
}

function currentNotebookRole(notebookId = state.currentNotebookId) {
  if (!notebookId) return '-';
  const hostId = state.hostByNotebook[notebookId];
  if (!hostId || !state.deviceId) return '-';
  return hostId === state.deviceId ? 'host' : 'client';
}

function handleHostChange(notebookId, prevHostId, nextHostId) {
  if (prevHostId === nextHostId) return;
  updateSyncDebug(`host-change:${(prevHostId || '-').slice(0,8)}→${(nextHostId || '-').slice(0,8)}`);
  if (!nextHostId) return;
  if (nextHostId === state.deviceId || prevHostId === state.deviceId) {
    setTimeout(() => {
      resyncVisibleSharedNotebooks('host-change', { minIntervalMs: 1000, sendMeta: true }).catch(() => {});
    }, 300);
  }
}

async function broadcastPresence() {
  const now = Date.now();
  for (const nbId of state.sharedNotebooks) {
    upsertPresence(nbId, state.deviceId, now);
    if (!_sharedRoomMap.get(nbId)) {
      try { await joinSharedNotebookP2P(nbId); } catch {}
    }
    const nbHash = _sharedRoomMap.get(nbId);
    if (nbHash) syncSend('nb-renamed', { deviceId: state.deviceId, notebookId: nbId, __presence: true, ts: now }, { roomId: nbHash });
  }
  updateSyncDebug('presence');
}

function buildNotebookMetaPayload(notebookId, pageIds = null) {
  const nb = state.notebooks.find(n => n.id === notebookId);
  if (!nb) return null;
  const allowed = pageIds?.length ? new Set(pageIds) : null;
  return {
    eventId: newEventId(),
    notebooks: [{
      id: nb.id,
      name: nb.name,
      pages: nb.pages
        .filter(p => !allowed || allowed.has(p.id))
        .map(pageMeta)
    }]
  };
}

async function applyMetaPayload(payload) {
  if (!payload?.notebooks?.length) return;
  for (const remoteNb of payload.notebooks) mergeNotebookMetaIntoState(remoteNb);
  state.notebooks.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  await saveAppMeta();
}

function sendNotebookMeta(notebookId, pageIds = null) {
  const payload = buildNotebookMetaPayload(notebookId, pageIds);
  if (!payload) return;
  p2pSendForNotebook('full-sync', payload);
  markSyncActivity('send:meta');
}

/** @returns {{id: string, strokes: Array, background: string}|undefined} */
function currentPage() {
  const nb = currentNotebook();
  if (!nb?.pages?.length) return undefined;
  const pageId = ensureCurrentPageId(state.currentNotebookId);
  return nb.pages.find(p => p.id === pageId) || nb.pages[0];
}

/** @returns {number} Position der aktuellen Seite unter den sichtbaren Seiten */
function currentPageIndex() {
  const nb = currentNotebook();
  if (!nb?.pages?.length) return 0;
  const pageId = ensureCurrentPageId(state.currentNotebookId);
  const idx = visiblePages(nb).findIndex(p => p.id === pageId);
  return idx >= 0 ? idx : 0;
}

/** @returns {number} Anzahl der sichtbaren Seiten */
function totalPages() {
  return visiblePages().length || 1;
}

// ─── IndexedDB Settings (device-local, not synced) ──────────────────────────

let settingsDB = null;

/** @returns {Promise<IDBDatabase>} */
function openSettingsDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('notizbuch-settings', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('settings');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {string} key
 * @returns {Promise<*>}
 */
function settingsGet(key) {
  return new Promise(resolve => {
    settingsDB.transaction('settings', 'readonly')
      .objectStore('settings').get(key).onsuccess = e => resolve(e.target.result ?? null);
  });
}

/**
 * @param {string} key
 * @param {*} value
 * @returns {Promise<void>}
 */
function settingsPut(key, value) {
  return new Promise(resolve => {
    settingsDB.transaction('settings', 'readwrite')
      .objectStore('settings').put(value, key).onsuccess = () => resolve();
  });
}

function settingsDelete(key) {
  return new Promise(resolve => {
    settingsDB.transaction('settings', 'readwrite')
      .objectStore('settings').delete(key).onsuccess = () => resolve();
  });
}

// ─── Theme (hell/dunkel, gerätelokal) ───────────────────────────────────────

const THEME_SETTING_KEY = 'device:theme';
const THEME_CHOICES = ['system', 'light', 'dark'];

/** @returns {'system'|'light'|'dark'} aktuell geltende Wahl */
function getTheme() {
  return window.__nbTheme?.get() || 'system';
}

/**
 * Theme wählen. 'system' folgt der Systemeinstellung (live), 'light'/'dark' haben Vorrang.
 * Gespeichert wird gerätelokal in IndexedDB (notizbuch-settings); das Inline-Skript in
 * app.html hält eine Kopie in localStorage, damit beim Laden nichts aufblitzt.
 * @param {'system'|'light'|'dark'} choice
 * @returns {Promise<string>} die tatsächlich gesetzte Wahl
 */
async function setTheme(choice) {
  if (!THEME_CHOICES.includes(choice)) choice = 'system';
  window.__nbTheme?.set(choice);
  if (settingsDB) {
    try { await settingsPut(THEME_SETTING_KEY, choice); } catch (e) { console.warn('[App] Theme konnte nicht gespeichert werden:', e); }
  }
  return choice;
}

/** Gespeicherte Wahl aus IndexedDB übernehmen (hat Vorrang vor der localStorage-Kopie). */
async function loadTheme() {
  try {
    const saved = await settingsGet(THEME_SETTING_KEY);
    const choice = THEME_CHOICES.includes(saved) ? saved : 'system';
    if (choice !== getTheme()) window.__nbTheme?.set(choice);
  } catch (e) {
    console.warn('[App] Theme konnte nicht geladen werden:', e);
  }
}

window.setTheme = setTheme;
window.getTheme = getTheme;

// ─── Browser/Device Detection ───────────────────────────────────────────────

/** @returns {string} z.B. "Chrome Desktop", "Firefox Android" */
function getClientName() {
  const ua = navigator.userAgent;
  let browser = 'Browser';
  if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome')) browser = 'Chrome';
  else if (ua.includes('Safari')) browser = 'Safari';
  let device = 'Desktop';
  if (/Android/i.test(ua)) device = 'Android';
  else if (/iPad/i.test(ua)) device = 'iPad';
  else if (/iPhone/i.test(ua)) device = 'iPhone';
  else if (/Mobile/i.test(ua)) device = 'Mobile';
  return `${browser} ${device}`;
}

// ─── Serialization ──────────────────────────────────────────────────────────

/**
 * Strokes verschlüsselt serialisieren (für OPFS-Storage).
 * JSON → UTF-8 → AES-GCM encrypt(notebookKey) → Uint8Array
 * @param {Array} strokes
 * @param {string} notebookId
 * @returns {Promise<Uint8Array>}
 */
/**
 * Seiten, deren Plattenstand schon in den Speicher gemischt wurde. Beim Start wird nur die
 * Meta geladen; die Events einer Seite kommen erst mit loadPage() dazu.
 * @type {WeakSet<object>}
 */
const _pagesMergedFromDisk = new WeakSet();

/** Vollständiges Event-Log einer Seite, sortiert und in der Form, in der es gespeichert wird. */
function storablePageEvents(page) {
  ensurePageEvents(page);
  return sortPageEvents(page.events || []).map(event => event.type === 'stroke' ? ({
    ...event,
    stroke: {
      ...event.stroke,
      points: roundPoints(event.stroke?.points || []),
      tool: event.stroke?.tool || 'pen',
      createdAt: strokeCreatedAt(event.stroke)
    }
  }) : event);
}

/**
 * true, während eine Sicherung Schlüssel und Daten dieses Geräts ersetzt. Solange darf nichts
 * anderes speichern oder mischen (kein Autosave, kein Sync), bis die App neu geladen ist.
 */
let _dataSwapRunning = false;

async function serializePageData(page, notebookId) {
  // Nie einen unvollständigen Speicherstand schreiben: Erreicht ein Sync-Event eine Seite,
  // die noch nicht von der Platte geladen wurde, würde sonst die Datei (und die Relay-Kopie)
  // mit dem unvollständigen Event-Log überschrieben.
  if (notebookId && page?.id && !_pagesMergedFromDisk.has(page)) {
    await loadPage(notebookId, page.id, page);
  }
  const payload = { version: 2, events: storablePageEvents(page) };
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  try {
    const key = await getNotebookKey(notebookId);
    return encrypt(key, plain);
  } catch (e) {
    console.warn('[Crypto] Verschlüsselung fehlgeschlagen, speichere plain:', e);
    return plain;
  }
}

/**
 * Verschlüsselte Uint8Array zu Stroke-Array deserialisieren.
 * Uint8Array → AES-GCM decrypt(notebookKey) → UTF-8 → JSON
 * @param {Uint8Array} data
 * @param {string} notebookId
 * @returns {Promise<Array>}
 */
async function deserializePageData(data, notebookId) {
  let parsed = null;
  try {
    const key = await getNotebookKey(notebookId);
    const plainBuf = await decrypt(key, data);
    parsed = JSON.parse(new TextDecoder().decode(plainBuf));
  } catch {
    try {
      parsed = JSON.parse(new TextDecoder().decode(data));
    } catch {
      parsed = null;
    }
  }
  if (!parsed) return { events: [] };
  if (Array.isArray(parsed)) {
    return {
      events: parsed.map((stroke, i) => ({
        id: `legacy:${stroke.id || i}`,
        type: 'stroke',
        createdAt: strokeCreatedAt(stroke),
        deviceId: stroke.deviceId || 'legacy',
        seq: i,
        stroke
      }))
    };
  }
  if (parsed.version === 2 && Array.isArray(parsed.events)) return parsed;
  return { events: [] };
}

// ─── Page Load / Save ───────────────────────────────────────────────────────

let _saveTimer = null;

/**
 * Aktuelle Seite speichern (debounced, 1s).
 */
function saveCurrentPage() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_flushSave, 1000);
}

/** Sofort speichern (für beforeunload). */
function flushSave() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  _flushSave();
}

let _sharedPushTimer = null;
let _sharedWakeTimer = null;
let _lastSharedResyncAt = 0;
let _lastHeartbeatAt = 0;
let _lastRelayMergeAt = 0;
let _lastRelayLiveInAt = 0;
let _lastP2PInAt = 0;
let _lastP2POutAt = 0;
let _syncDebugStatus = 'idle';
let _lastSyncActivity = 0;

async function _flushSave() {
  _saveTimer = null;
  if (_dataSwapRunning) return;
  const page = currentPage();
  if (!page) return;
  const nbId = state.currentNotebookId;
  const data = await serializePageData(page, nbId);
  await savePageData(nbId, String(page.id), data);
  relayPut(`p:${nbId}/${page.id}`, data);
  // Geteiltes Notebook: debounced an shared Relay-Room pushen (3s)
  if (state.sharedNotebooks.has(nbId)) {
    if (_sharedPushTimer) clearTimeout(_sharedPushTimer);
    _sharedPushTimer = setTimeout(() => {
      _sharedPushTimer = null;
      pushSharedNotebook(nbId, { pageIds: [page.id] });
    }, 3000);
  }
}

/**
 * Seite laden: OPFS-Daten mit In-Memory Events (von P2P) mergen.
 * Union-Merge by event.id — Remote-Events die während der Navigation ankamen bleiben erhalten.
 * @param {string} notebookId
 * @param {string} pageId
 * @param {{id: string, events: Array}} page - Page-Objekt (wird mutiert)
 */
async function loadPage(notebookId, pageId, page) {
  const data = await loadPageData(notebookId, pageId);
  const disk = data ? await deserializePageData(data, notebookId) : { events: [] };
  mergePageEvents(page, disk.events || []);
  _pagesMergedFromDisk.add(page);
}

// ─── Meta Persistence ───────────────────────────────────────────────────────

/**
 * App-Metadaten speichern (Notebook-Struktur + NotebookKeys, ohne Strokes).
 * @param {{local?: boolean}} [opts] - local: nur auf dieses Gerät schreiben, nicht ans Relay
 */
async function saveAppMeta(opts = {}) {
  if (_dataSwapRunning && !opts.local) return;
  // NotebookKeys sammeln (raw bytes als Array)
  const nbKeys = {};
  for (const nb of state.notebooks) {
    try {
      const key = await getNotebookKey(nb.id);
      const raw = await exportKey(key);
      nbKeys[nb.id] = Array.from(raw);
    } catch {}
  }
  const meta = {
    notebooks: state.notebooks.map(nb => ({
      id: nb.id,
      name: nb.name,
      pages: nb.pages.map(pageMeta)
    })),
    notebookKeys: nbKeys
  };
  // Meta mit MasterKey verschlüsseln
  const plain = new TextEncoder().encode(JSON.stringify(meta));
  try {
    const masterKey = await getMasterCryptoKey();
    if (masterKey) {
      const encrypted = await encrypt(masterKey, plain);
      await saveMeta(encrypted);
      if (!opts.local) relayPut('meta', encrypted);
    } else {
      await saveMeta(meta); // Fallback: plain
    }
  } catch {
    await saveMeta(meta);
  }
}

/** App-Metadaten laden und Notebooks wiederherstellen. */
async function loadAppMeta() {
  const raw = await loadMeta();
  if (!raw) return;
  let meta;
  if (raw instanceof Uint8Array || raw?.type === 'Buffer' || ArrayBuffer.isView(raw)) {
    // Verschlüsselt — mit MasterKey entschlüsseln
    try {
      const masterKey = await getMasterCryptoKey();
      if (!masterKey) return;
      const plainBuf = await decrypt(masterKey, raw);
      meta = JSON.parse(new TextDecoder().decode(plainBuf));
    } catch {
      return; // Entschlüsselung fehlgeschlagen
    }
  } else if (typeof raw === 'object' && raw.notebooks) {
    meta = raw; // Plain-JSON (Migration bestehender Daten)
  } else {
    return;
  }
  if (!meta?.notebooks?.length) return;
  state.notebooks = meta.notebooks.map(nb => ({
    id: nb.id,
    name: nb.name,
    pages: (nb.pages || []).map(p => ({ ...pageMeta(p), strokes: [] }))
  }));
  state.notebooks.forEach(normalizePageOrder);
  // NotebookKeys aus Meta installieren (fehlende)
  await installNotebookKeys(meta.notebookKeys);
}

/**
 * NotebookKeys aus Meta-Objekt in State + localStorage installieren.
 * Überschreibt keine bereits vorhandenen Keys.
 * @param {Object<string, number[]>} keys - { notebookId: [raw bytes] }
 */
async function installNotebookKeys(keys) {
  if (!keys) return;
  for (const [nbId, rawArr] of Object.entries(keys)) {
    if (state.notebookKeys[nbId] || !rawArr?.length) continue;
    try {
      const key = await importKey(new Uint8Array(rawArr), true);
      state.notebookKeys[nbId] = key;
      localStorage.setItem(`notizbuch:nbKey:${nbId}`, JSON.stringify(rawArr));
    } catch {}
  }
}

// ─── Canvas Management ──────────────────────────────────────────────────────

/** Canvas-Größen an Container anpassen. */
function setupCanvases() {
  const container = document.getElementById('canvas-container');
  if (!container) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;

  for (const c of [bgCanvas, staticCanvas, activeCanvas]) {
    if (!c) continue;
    c.width = w * DPR;
    c.height = h * DPR;
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    c.getContext('2d').setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  redrawBackground();
  redrawStrokes();
}

/** Alle Canvas-Layer komplett leeren (bei Seitenwechsel). */
function clearAllCanvases() {
  for (const c of [bgCanvas, staticCanvas, activeCanvas]) {
    if (!c) continue;
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  strokeCacheCanvas = null; // Cache invalidieren
}

/** Hintergrund auf bgCanvas zeichnen. */
function redrawBackground() {
  if (!bgCtx || !bgCanvas) return;
  const w = bgCanvas.width / DPR;
  const h = bgCanvas.height / DPR;
  const bg = currentPage()?.background || 'grid';
  drawBackground(bgCtx, w, h, bg, state.viewX, state.viewY, state.viewScale);
  // Wird bei jedem Pan/Zoom durchlaufen: billiger Vergleich gegen den Ausschnitt
  updateContentHint();
}

/** Hintergrund der aktuellen Seite ändern. */
async function setBackground(bg) {
  const page = currentPage();
  if (!page || page.background === bg || isPageGone(page)) return;
  page.background = bg;
  redrawBackground();
  await saveAppMeta();
  sendNotebookMeta(state.currentNotebookId, [page.id]);
  renderUI();
}

/**
 * Alle Strokes auf staticCanvas + Bitmap-Cache neu zeichnen.
 * Wird bei Seitenwechsel, Undo, Clear, Sync aufgerufen.
 */
function redrawStrokes() {
  if (!staticCanvas) return;
  const w = staticCanvas.width;
  const h = staticCanvas.height;
  if (w === 0 || h === 0) return;

  // Bitmap-Cache erstellen/aktualisieren
  if (!strokeCacheCanvas || strokeCacheCanvas.width !== w || strokeCacheCanvas.height !== h) {
    strokeCacheCanvas = document.createElement('canvas');
    strokeCacheCanvas.width = w;
    strokeCacheCanvas.height = h;
  }

  const cacheCtx = strokeCacheCanvas.getContext('2d');
  cacheCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  cacheCtx.clearRect(0, 0, w / DPR, h / DPR);

  const page = currentPage();
  const strokes = displayStrokes(page);
  noteContentMaybeChanged(page, strokes);
  cacheCtx.save();
  cacheCtx.translate(state.viewX, state.viewY);
  cacheCtx.scale(state.viewScale, state.viewScale);
  for (const s of strokes) {
    drawStrokeToCanvas(cacheCtx, s);
  }
  cacheCtx.restore();

  cacheViewX = state.viewX;
  cacheViewY = state.viewY;
  cacheViewScale = state.viewScale;

  // Auf sichtbares Canvas kopieren (1:1 Pixel)
  const ctx = staticCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(strokeCacheCanvas, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawSelectionOverlay();
}

/**
 * Bitmap-Cache auf staticCanvas compositen (für Pan/Zoom ohne Full-Redraw).
 * Berechnet Delta zwischen Cache-Transform und aktuellem Transform.
 */
function compositeStrokes() {
  if (!staticCanvas || !strokeCacheCanvas) { redrawStrokes(); return; }
  const w = staticCanvas.width;
  const h = staticCanvas.height;
  const ctx = staticCtx;

  const scaleRatio = state.viewScale / cacheViewScale;
  const tx = (state.viewX - cacheViewX * scaleRatio) * DPR;
  const ty = (state.viewY - cacheViewY * scaleRatio) * DPR;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.translate(tx, ty);
  ctx.scale(scaleRatio, scaleRatio);
  ctx.drawImage(strokeCacheCanvas, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // Der Auswahlrahmen folgt Pan/Zoom
  drawSelectionOverlay();
}

// ─── Fit to Content ─────────────────────────────────────────────────────────

/**
 * Bounding-Box der sichtbaren Strokes berechnen.
 * Rendert alle Strokes (inkl. Eraser) auf ein temporäres Canvas und
 * ermittelt die Pixel-Bounding-Box. So werden radierte Bereiche korrekt ignoriert.
 * @param {Array|null} [strokes] - sichtbare Striche; ohne Angabe die der aktuellen Seite
 * @param {number} [maxDim] - größte Kantenlänge des Hilfs-Canvas (kleiner = schneller, gröber)
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
 */
function computeStrokeBounds(strokes = null, maxDim = 2000) {
  const page = strokes ? null : currentPage();
  const visible = strokes || (page ? materializePage(page) : []);
  if (!visible.length) return null;

  // Grobe Bounds aus Stroke-Daten (für Canvas-Größe)
  let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity;
  for (const s of visible) {
    for (const p of (s.points || [])) {
      if (p.x < rMinX) rMinX = p.x;
      if (p.y < rMinY) rMinY = p.y;
      if (p.x > rMaxX) rMaxX = p.x;
      if (p.y > rMaxY) rMaxY = p.y;
    }
  }
  if (!isFinite(rMinX)) return null;

  // Temporäres Canvas in World-Koordinaten (1px = 1 unit, max 2000px)
  const margin = 20;
  const w = rMaxX - rMinX + margin * 2;
  const h = rMaxY - rMinY + margin * 2;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const cw = Math.ceil(w * scale);
  const ch = Math.ceil(h * scale);
  if (cw <= 0 || ch <= 0) return null;

  const tmp = document.createElement('canvas');
  tmp.width = cw;
  tmp.height = ch;
  const ctx = tmp.getContext('2d');
  ctx.translate(-(rMinX - margin) * scale, -(rMinY - margin) * scale);
  ctx.scale(scale, scale);
  for (const s of visible) {
    drawStrokeToCanvas(ctx, s);
  }

  // Pixel-Bounding-Box der nicht-transparenten Pixel
  const imgData = ctx.getImageData(0, 0, cw, ch).data;
  let pMinX = cw, pMinY = ch, pMaxX = 0, pMaxY = 0;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (imgData[(y * cw + x) * 4 + 3] > 0) {
        if (x < pMinX) pMinX = x;
        if (x > pMaxX) pMaxX = x;
        if (y < pMinY) pMinY = y;
        if (y > pMaxY) pMaxY = y;
      }
    }
  }
  if (pMinX > pMaxX) return null;

  // Pixel-Koordinaten zurück in World-Koordinaten
  return {
    minX: pMinX / scale + (rMinX - margin),
    minY: pMinY / scale + (rMinY - margin),
    maxX: pMaxX / scale + (rMinX - margin),
    maxY: pMaxY / scale + (rMinY - margin)
  };
}

/**
 * View berechnen um alle Strokes zentriert + mit Padding anzuzeigen.
 * @returns {{scale: number, x: number, y: number}}
 */
function computeFitView() {
  const container = document.getElementById('canvas-container');
  if (!container) return { scale: 1, x: 0, y: 0 };
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const bounds = computeStrokeBounds();
  // Frisch berechnete Grenzen gleich für den Hinweis „Weiterer Inhalt“ merken
  setContentBounds(bounds);
  if (!bounds) return { scale: 1, x: 0, y: 0 };
  const pad = 40;
  const bw = bounds.maxX - bounds.minX + pad * 2;
  const bh = bounds.maxY - bounds.minY + pad * 2;
  const scale = Math.min(cw / bw, ch / bh, 1);
  const cx = bounds.minX - pad;
  const cy = bounds.minY - pad;
  const x = (cw - bw * scale) / 2 - cx * scale;
  const y = (ch - bh * scale) / 2 - cy * scale;
  return { scale, x, y };
}

/**
 * View anpassen um alle Strokes sichtbar + zentriert anzuzeigen.
 * Wird vom Home-Button aufgerufen.
 */
function fitToContent() {
  _shownPageKey = pageKey();
  const { scale, x, y } = computeFitView();
  state.viewScale = scale;
  state.viewX = x;
  state.viewY = y;
  clearAllCanvases();
  redrawBackground();
  redrawStrokes();
  updateSyncDebug();
}

/**
 * Um die Bildschirmmitte zoomen (Knöpfe − / + in der Zoom-Pille).
 * @param {number} factor
 */
function zoomBy(factor) {
  if (!bgCanvas) return;
  const w = bgCanvas.width / DPR;
  const h = bgCanvas.height / DPR;
  const newScale = Math.min(8, Math.max(0.2, state.viewScale * factor));
  const worldX = (w / 2 - state.viewX) / state.viewScale;
  const worldY = (h / 2 - state.viewY) / state.viewScale;
  state.viewX = w / 2 - worldX * newScale;
  state.viewY = h / 2 - worldY * newScale;
  state.viewScale = newScale;
  redrawBackground();
  redrawStrokes();
  updateSyncDebug();
}

// ─── Hinweis „Weiterer Inhalt“ ──────────────────────────────────────────────
// Die Inhalts-Grenzen (Weltkoordinaten) werden einmal pixelgenau bestimmt
// (computeStrokeBounds — Radiertes zählt nicht) und gecacht. Neu berechnet wird nur,
// wenn sich die Striche der Seite ändern (entprellt). Bei Pan/Zoom wird der Cache nur
// gegen den sichtbaren Ausschnitt verglichen. Die Ansicht wird nie automatisch verschoben.

/** @type {{minX:number,minY:number,maxX:number,maxY:number}|null} */
let _contentBounds = null;
let _contentBoundsSig = '';
let _contentBoundsTimer = null;
/** @type {string|null} aktuell angezeigte Richtung ('left'|'right'|'up'|'down') */
let _contentHintDir = null;

/** Kennung für „welche Striche liegen auf der Seite“ — Events werden nur angehängt. */
function contentSignature(page = currentPage(), strokes = null) {
  if (!page) return '';
  const n = strokes ? strokes.length : (page.strokes?.length || 0);
  return `${state.currentNotebookId}/${page.id}:${page.events?.length || 0}:${page.clearedAt || 0}:${page.deletedAt || 0}:${n}`;
}

function setContentBounds(bounds) {
  if (_contentBoundsTimer) { clearTimeout(_contentBoundsTimer); _contentBoundsTimer = null; }
  _contentBounds = bounds;
  const page = currentPage();
  _contentBoundsSig = contentSignature(page, page ? materializePage(page) : []);
  updateContentHint();
}

/** Von redrawStrokes() aufgerufen: bei geänderten Strichen Neuberechnung einplanen. */
function noteContentMaybeChanged(page, strokes) {
  if (contentSignature(page, strokes) === _contentBoundsSig) return;
  scheduleContentBounds();
}

function scheduleContentBounds(delay = 400) {
  if (_contentBoundsTimer) clearTimeout(_contentBoundsTimer);
  _contentBoundsTimer = setTimeout(() => {
    _contentBoundsTimer = null;
    // Nicht mitten im Strich oder in einer Geste rechnen
    if (isDrawing || isPanning || pinchState.active) { scheduleContentBounds(250); return; }
    setContentBounds(computeStrokeBounds());
  }, delay);
}

/** Billiger Vergleich: liegt Inhalt außerhalb des sichtbaren Ausschnitts — und wo? */
function updateContentHint() {
  let dir = null;
  const b = _contentBounds;
  if (b && bgCanvas && !isPageGone()) {
    const w = bgCanvas.width / DPR;
    const h = bgCanvas.height / DPR;
    const s = state.viewScale;
    const over = {
      left: -(b.minX * s + state.viewX),
      right: b.maxX * s + state.viewX - w,
      up: -(b.minY * s + state.viewY),
      down: b.maxY * s + state.viewY - h
    };
    let max = 2; // Toleranz in px
    for (const k in over) {
      if (over[k] > max) { max = over[k]; dir = k; }
    }
  }
  if (dir === _contentHintDir) return;
  _contentHintDir = dir;
  const main = document.getElementById('main');
  if (main) main.dataset.off = String(!!dir);
  const hint = document.getElementById('btn-edge-hint');
  if (hint) {
    if (dir) hint.dataset.dir = dir;
    hint.hidden = !dir;
  }
}

// ─── Navigation ─────────────────────────────────────────────────────────────

/** Kennung der Seite, die gerade auf der Zeichenfläche liegt (gesetzt in fitToContent/showCurrentPage). */
let _shownPageKey = '';

function pageKey(notebookId = state.currentNotebookId, page = currentPage()) {
  return page ? `${notebookId}/${page.id}` : '';
}

/** Aktuelle Seite laden und frisch anzeigen (Seitenwechsel, Sprung nach dem Löschen). */
async function showCurrentPage() {
  const notebookId = state.currentNotebookId;
  const page = currentPage();
  if (!page) return;
  _shownPageKey = pageKey(notebookId, page);
  try { await loadPage(notebookId, page.id, page); } catch (e) { console.warn('[App] Seite konnte nicht geladen werden:', e); }
  if (state.currentNotebookId !== notebookId || currentPage() !== page) return;
  // Alle Canvas-Layer komplett leeren vor dem Neuzeichnen
  clearAllCanvases();
  redrawBackground();
  fitToContent();
  renderUI();
  saveLocalSettings();
}

/** Leere Seite ans Ende hängen (nur im Speicher — Speichern/Senden macht der Aufrufer). */
function appendPage(nb, id, createdAt, background = 'grid') {
  const page = { id, strokes: [], background, order: nb.pages.length, createdAt, deletedAt: 0, restoredAt: 0 };
  nb.pages.push(page);
  normalizePageOrder(nb);
  return page;
}

/**
 * Ersatzseite, wenn die letzte sichtbare Seite gelöscht wurde. Die ID hängt nur vom
 * Löschzeitpunkt ab: legen zwei Geräte sie gleichzeitig an, ist es dieselbe Seite.
 */
function appendReplacementPage(nb, at) {
  const id = nb.pages.some(p => p.id === `auto-${at}`) ? newId() : `auto-${at}`;
  return appendPage(nb, id, at, nb.pages[nb.pages.length - 1]?.background || 'grid');
}

/** Sind alle Seiten eines Notizbuchs gelöscht (z. B. durch ein anderes Gerät), entsteht eine neue leere. */
function ensureVisiblePage(nb) {
  if (!nb?.pages?.length || visiblePages(nb).length) return;
  const page = appendReplacementPage(nb, Math.max(0, ...nb.pages.map(p => p.deletedAt || 0)));
  saveAppMeta().then(() => sendNotebookMeta(nb.id, [page.id])).catch(() => {});
}

/**
 * Von renderUI() aufgerufen: Zeigt die Zeichenfläche noch eine andere Seite als die aktuelle
 * (aktuelle Seite auf einem anderen Gerät gelöscht → Nachbarseite), wird sie nachgezogen.
 */
function reconcileShownPage() {
  const nb = currentNotebook();
  if (!nb || !bgCanvas) return;
  ensureVisiblePage(nb);
  const key = pageKey();
  if (key && key !== _shownPageKey) showCurrentPage();
}

/**
 * Zu einer Seite im aktuellen Notebook navigieren.
 * @param {string} pageId
 */
async function goToPageId(pageId) {
  const nb = currentNotebook();
  const target = nb?.pages.find(p => p.id === pageId);
  if (!target || isPageDeleted(target)) return;
  await commitPendingPageOp();
  if (isPageDeleted(target)) return;
  flushSave();
  state.currentPageIds[state.currentNotebookId] = target.id;
  await showCurrentPage();
}

/**
 * Zur n-ten sichtbaren Seite (gelöschte zählen nicht mit).
 * @param {number} index
 */
async function goToPage(index) {
  const target = visiblePages()[index];
  if (target) await goToPageId(target.id);
}

/** Nächste Seite. Legt keine Seite an — dafür gibt es addPage(). */
async function nextPage() {
  await goToPage(currentPageIndex() + 1);
}

/** Neue Seite am Ende anlegen und dorthin wechseln („+“ in der Seiten-Pille und in der Übersicht). */
async function addPage() {
  const nb = currentNotebook();
  if (!nb) return;
  await commitPendingPageOp();
  const page = appendPage(nb, newId(), Date.now(), currentPage()?.background || 'grid');
  await saveAppMeta();
  sendNotebookMeta(state.currentNotebookId, [page.id]);
  await goToPageId(page.id);
  showToast(`Seite ${currentPageIndex() + 1} angelegt`, { key: 'page-add' });
  refreshPageOverview();
}

/** Vorherige Seite. */
async function prevPage() {
  const idx = currentPageIndex();
  if (idx > 0) await goToPage(idx - 1);
}

// ─── Seite leeren / löschen mit „Rückgängig“ ────────────────────────────────
//
// clearedAt und deletedAt werden zwischen Geräten per Maximum gemischt
// (applyPageMeta, mergeSharedNotebookData). Ein einmal verteilter Wert lässt sich
// deshalb nicht zurücknehmen. Darum wirkt Leeren/Löschen zuerst nur lokal und wird
// erst festgeschrieben (gespeichert + verteilt), wenn der Hinweis ohne „Rückgängig“
// abgelaufen ist — oder früher: beim Seiten-/Notizbuchwechsel, beim Verstecken der
// Seite und beim nächsten eigenen Strich.
// Aufheben lässt sich ein festgeschriebenes Löschen nur über ein zweites Feld:
// restorePage() setzt restoredAt > deletedAt (siehe isPageDeleted).

const PENDING_OP_KEY = 'notizbuch:pendingPageOp';

function pendingOpPage(op) {
  const nb = state.notebooks.find(n => n.id === op.notebookId);
  return nb?.pages.find(p => p.id === op.pageId) || null;
}

/** Anzeige nach Vormerken/Zurücknehmen eines Leerens auffrischen (nur wenn die Seite offen ist). */
function refreshPendingOpView(op) {
  const page = pendingOpPage(op);
  if (!page) return;
  refreshPageMaterializedState(page);
  if (op.notebookId !== state.currentNotebookId || page.id !== currentPage()?.id) return;
  redrawStrokes();
  renderUI();
  updateSyncDebug();
}

/**
 * Aktuelle Seite leeren oder löschen — sofort sichtbar, mit „Rückgängig“ im Hinweis.
 * Löschen: Die Ansicht springt auf die Nachbarseite; die gelöschte Seite steht nur noch in der
 * Seitenübersicht unter „Gelöschte Seiten“. War es die letzte Seite, entsteht eine neue leere.
 * @param {'clear'|'delete'} kind
 */
function startPendingPageOp(kind) {
  const nb = currentNotebook();
  const page = currentPage();
  if (!nb || !page || isPageGone(page)) return;
  commitPendingPageOp();
  const op = { kind, notebookId: nb.id, pageId: page.id, at: Date.now(), toast: null, autoPageId: null };
  let text = 'Seite geleert';
  let next = null;
  if (kind === 'delete') {
    flushSave();
    const pages = visiblePages(nb);
    const idx = pages.indexOf(page);
    text = `Seite ${idx + 1} gelöscht`;
    next = pages[idx + 1] || pages[idx - 1] || null;
  }
  _pendingPageOp = op;
  // Merkzettel für den Fall, dass die App in der Frist geschlossen wird (siehe recoverPendingPageOp)
  try { localStorage.setItem(PENDING_OP_KEY, JSON.stringify({ kind, notebookId: op.notebookId, pageId: op.pageId, at: op.at })); } catch {}
  if (kind === 'delete') {
    if (!next) {
      // Ersatzseite: bis zum Festschreiben nur im Speicher, „Rückgängig“ nimmt sie wieder weg
      next = appendReplacementPage(nb, op.at);
      op.autoPageId = next.id;
    }
    state.currentPageIds[nb.id] = next.id;
    showCurrentPage();
    refreshPageOverview();
  } else {
    refreshPendingOpView(op);
  }
  op.toast = showToast(text, {
    key: 'page-op',
    action: { label: 'Rückgängig', onClick: () => revertPendingPageOp(op) },
    onExpire: () => commitPendingPageOp(op)
  });
}

function forgetPendingOpNote(op) {
  try {
    const note = JSON.parse(localStorage.getItem(PENDING_OP_KEY) || 'null');
    if (!note || (note.pageId === op.pageId && note.at === op.at)) localStorage.removeItem(PENDING_OP_KEY);
  } catch {
    try { localStorage.removeItem(PENDING_OP_KEY); } catch {}
  }
}

/** „Rückgängig“ innerhalb der Frist: alter Zustand, ohne Speichern und ohne Sync-Nachricht. */
function revertPendingPageOp(op = _pendingPageOp) {
  if (!op || _pendingPageOp !== op) return false;
  _pendingPageOp = null;
  forgetPendingOpNote(op);
  op.toast?.dismiss();
  if (op.kind === 'delete') {
    const nb = state.notebooks.find(n => n.id === op.notebookId);
    const auto = op.autoPageId ? nb?.pages.findIndex(p => p.id === op.autoPageId) : -1;
    // Die Ersatzseite verschwindet wieder, solange nichts darauf liegt
    if (auto >= 0 && !nb.pages[auto].events?.length) { nb.pages.splice(auto, 1); normalizePageOrder(nb); }
    // Zurück zur wiederhergestellten Seite
    if (nb && pendingOpPage(op)) {
      state.currentPageIds[nb.id] = op.pageId;
      if (nb.id === state.currentNotebookId) showCurrentPage();
    }
    refreshPageOverview();
  } else {
    refreshPendingOpView(op);
  }
  showToast(op.kind === 'clear' ? 'Inhalt wiederhergestellt' : 'Seite wiederhergestellt', { key: 'page-op' });
  return true;
}

/**
 * Vorgemerktes Leeren/Löschen festschreiben: Wert in die Seite übernehmen, Meta speichern, verteilen.
 * Der Wert steht synchron in der Seite; Speichern und Senden folgen asynchron.
 */
async function commitPendingPageOp(op = _pendingPageOp, opts = {}) {
  if (!op || _pendingPageOp !== op) return;
  _pendingPageOp = null;
  op.toast?.dismiss();
  const page = pendingOpPage(op);
  if (!page) { forgetPendingOpNote(op); return; }
  if (op.kind === 'clear') {
    page.clearedAt = Math.max(page.clearedAt || 0, op.at);
    // Nach dem Leeren gibt es nichts mehr zu wiederholen
    clearRedoStack(op.notebookId, page.id);
    refreshPageMaterializedState(page);
  } else {
    // Muss über einem früheren Wiederherstellen liegen (isPageDeleted)
    page.deletedAt = Math.max(page.deletedAt || 0, op.at, (page.restoredAt || 0) + 1);
  }
  updateRedoButton();
  try {
    await saveAppMeta();
    // Beim Entladen der Seite bleibt der Merkzettel liegen: Speichern/Senden kann dann
    // abreißen, der nächste Start holt es nach (recoverPendingPageOp, wirkt nur als Maximum).
    if (!opts.keepNote) forgetPendingOpNote(op);
  } catch (e) {
    console.warn('[App] Leeren/Löschen konnte nicht gespeichert werden:', e);
  }
  if (op.kind === 'clear' && op.notebookId === state.currentNotebookId && page.id === currentPage()?.id) saveCurrentPage();
  sendNotebookMeta(op.notebookId, op.autoPageId ? [page.id, op.autoPageId] : [page.id]);
  refreshPageOverview();
}

/**
 * Beim Start: Wurde die App geschlossen, während ein Hinweis mit „Rückgängig“ noch lief,
 * gilt das Leeren/Löschen als gewollt und wird jetzt nachgeholt.
 */
async function recoverPendingPageOp() {
  let note = null;
  try { note = JSON.parse(localStorage.getItem(PENDING_OP_KEY) || 'null'); } catch {}
  if (!note) return;
  const at = Number(note.at) || 0;
  const page = at && (note.kind === 'clear' || note.kind === 'delete') ? pendingOpPage(note) : null;
  if (page) {
    if (note.kind === 'clear') page.clearedAt = Math.max(page.clearedAt || 0, at);
    else page.deletedAt = Math.max(page.deletedAt || 0, at, (page.restoredAt || 0) + 1);
    await saveAppMeta();
    announceRecoveredPageOp(note.notebookId, page.id);
  }
  try { localStorage.removeItem(PENDING_OP_KEY); } catch {}
}

/** Nachgeholtes Leeren/Löschen verteilen, sobald der Live-Kanal der eigenen Geräte steht. */
function announceRecoveredPageOp(notebookId, pageId, tries = 60) {
  const up = liveChannelStatus().some(ch => ch.roomKey === state.masterKeyHash && ch.state === 'verbunden');
  if (up || tries <= 0) { sendNotebookMeta(notebookId, [pageId]); return; }
  setTimeout(() => announceRecoveredPageOp(notebookId, pageId, tries - 1), 500);
}

/** Aktuelle Seite löschen — mit „Rückgängig“ im Hinweis. */
function deletePage() {
  startPendingPageOp('delete');
}

/**
 * Gelöschte Seite wiederherstellen (Seitenübersicht → „Gelöschte Seiten“).
 * deletedAt bleibt stehen — es wird zwischen Geräten per Maximum gemischt und ließe sich
 * nicht zurücknehmen. Stattdessen bekommt die Seite ein neueres restoredAt.
 * @param {string} pageId
 * @param {string} [notebookId]
 * @returns {Promise<boolean>}
 */
async function restorePage(pageId, notebookId = state.currentNotebookId) {
  const nb = state.notebooks.find(n => n.id === notebookId);
  const page = nb?.pages.find(p => p.id === pageId);
  if (!page) return false;
  // Läuft der Hinweis noch, ist nichts festgeschrieben: einfach zurücknehmen
  if (isPendingDelete(page)) return revertPendingPageOp();
  if (!isPageDeleted(page)) return false;
  page.restoredAt = Math.max(Date.now(), (page.deletedAt || 0) + 1);
  await saveAppMeta();
  sendNotebookMeta(notebookId, [page.id]);
  // Geteiltes Notizbuch: auch den Stand im Relay-Room nachziehen (für Teilnehmer, die gerade offline sind)
  if (state.sharedNotebooks.has(notebookId)) pushSharedNotebook(notebookId, { pageIds: [page.id] }).catch(() => {});
  renderUI();
  refreshPageOverview();
  showToast('Seite wiederhergestellt', { key: 'page-op' });
  return true;
}

// ─── Seitenübersicht ────────────────────────────────────────────────────────
// Raster mit Vorschaubildern, geöffnet über den Zähler in der Seiten-Pille; darunter
// „Gelöschte Seiten“ mit „Wiederherstellen“. Die Vorschauen entstehen träge: erst wenn
// eine Kachel ins Bild kommt (IntersectionObserver), eine nach der anderen, mit Pausen
// dazwischen — so friert die Oberfläche auch bei vielen Seiten nicht ein. Gezeichnet wird
// mit den Funktionen aus canvas.js auf eigene Canvases. Ansicht, Cache-Canvas und aktuelle
// Seite der Hauptansicht bleiben unberührt: Seitendaten werden in eine Kopie geladen.

const THUMB_W = 320;
const THUMB_H = 240;
/** Näher als ein 800 px breiter Ausschnitt bei 100 % zoomt die Vorschau nicht heran. */
const THUMB_VIEW_W = 800;
const THUMB_CACHE_MAX = 300;

/** @type {Map<string, {sig: string, canvas: HTMLCanvasElement}>} notebookId/pageId → fertige Vorschau */
const _thumbCache = new Map();
/** @type {HTMLElement[]} Kacheln, die auf ihre Vorschau warten */
let _thumbQueue = [];
let _thumbBusy = false;
/** @type {IntersectionObserver|null} */
let _thumbObserver = null;
/** @type {HTMLCanvasElement|null} Hilfsfläche für die Striche (Radierer wirkt nur auf sie, nicht aufs Papier) */
let _thumbLayer = null;
let _overviewSig = '';

function isPageOverviewOpen() {
  const modal = document.getElementById('pages-modal');
  return !!modal && !modal.classList.contains('hidden');
}

/** Ändert sich diese Kennung, muss die Vorschau neu gezeichnet werden (Events werden nur angehängt). */
function thumbSignature(page) {
  return `${page.events?.length || 0}:${page.clearedAt || 0}:${pendingClearAt(page)}:${page.background || 'grid'}`;
}

/**
 * Vorschaubild einer Seite: weißes Papier, Papierart, Striche inkl. Radierer —
 * eingepasst wie fitToContent(); eine leere Seite zeigt den Standardausschnitt.
 * @param {Array} strokes - sichtbare Striche (materializePage)
 * @param {string} background
 * @returns {HTMLCanvasElement}
 */
function renderPageThumb(strokes, background) {
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const ctx = canvas.getContext('2d');
  let scale = THUMB_W / THUMB_VIEW_W, x = 0, y = 0;
  const bounds = strokes.length ? computeStrokeBounds(strokes, 400) : null;
  if (bounds) {
    const pad = 40;
    const bw = bounds.maxX - bounds.minX + pad * 2;
    const bh = bounds.maxY - bounds.minY + pad * 2;
    scale = Math.min(THUMB_W / bw, THUMB_H / bh, scale);
    x = (THUMB_W - bw * scale) / 2 - (bounds.minX - pad) * scale;
    y = (THUMB_H - bh * scale) / 2 - (bounds.minY - pad) * scale;
  }
  drawBackground(ctx, THUMB_W, THUMB_H, background, x, y, scale);
  // Papier unter die Linien legen
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  ctx.globalCompositeOperation = 'source-over';
  if (strokes.length) {
    if (!_thumbLayer) {
      _thumbLayer = document.createElement('canvas');
      _thumbLayer.width = THUMB_W;
      _thumbLayer.height = THUMB_H;
    }
    const layer = _thumbLayer.getContext('2d');
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalCompositeOperation = 'source-over';
    layer.clearRect(0, 0, THUMB_W, THUMB_H);
    layer.setTransform(scale, 0, 0, scale, x, y);
    for (const s of strokes) drawStrokeToCanvas(layer, s);
    ctx.drawImage(_thumbLayer, 0, 0);
  }
  return canvas;
}

/** Vorschau einer Kachel bereitstellen: aus dem Cache oder — wenn sich die Seite geändert hat — neu. */
async function fillThumbTile(tile) {
  const notebookId = tile._nbId;
  const page = state.notebooks.find(n => n.id === notebookId)?.pages.find(p => p.id === tile.dataset.page);
  if (!page) return;
  const sig = thumbSignature(page);
  const key = `${notebookId}/${page.id}`;
  let entry = _thumbCache.get(key);
  if (!entry || entry.sig !== sig) {
    // Kopie der Seite: Stand von der Platte mit dem im Speicher vereinigen, ohne den State anzufassen
    const copy = { id: page.id, clearedAt: page.clearedAt || 0, strokes: page.strokes || [] };
    if (Array.isArray(page.events)) copy.events = [...page.events];
    const isCurrent = notebookId === state.currentNotebookId && page === currentPage();
    if (!isCurrent) {
      try { await loadPage(notebookId, page.id, copy); } catch (e) { console.warn('[UI] Vorschau: Seite nicht lesbar', page.id, e); }
    }
    entry = { sig, canvas: renderPageThumb(materializePage(copy), page.background || 'grid') };
    _thumbCache.delete(key);
    _thumbCache.set(key, entry);
    if (_thumbCache.size > THUMB_CACHE_MAX) _thumbCache.delete(_thumbCache.keys().next().value);
  }
  paintThumbTile(tile, entry);
}

function paintThumbTile(tile, entry) {
  const canvas = tile.querySelector('canvas');
  if (!canvas) return;
  canvas.getContext('2d').drawImage(entry.canvas, 0, 0);
  tile._sig = entry.sig;
}

function queueThumbTile(tile) {
  if (tile._queued) return;
  tile._queued = true;
  _thumbQueue.push(tile);
  runThumbQueue();
}

/** Wartende Vorschauen nacheinander abarbeiten; nach jeder bekommt der Browser Luft für Eingaben. */
async function runThumbQueue() {
  if (_thumbBusy) return;
  _thumbBusy = true;
  try {
    while (_thumbQueue.length && isPageOverviewOpen()) {
      const tile = _thumbQueue.shift();
      tile._queued = false;
      if (!tile.isConnected) continue;
      try { await fillThumbTile(tile); } catch (e) { console.warn('[UI] Vorschau:', e); }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally {
    _thumbBusy = false;
  }
}

function deletedAgoText(ts) {
  const day = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((day(Date.now()) - day(ts || Date.now())) / 86400000);
  if (days <= 0) return 'heute gelöscht';
  return days === 1 ? 'gestern gelöscht' : `vor ${days} Tagen gelöscht`;
}

/** Eine Kachel der Übersicht. Gelöschte Seiten: Bild nicht anklickbar, dafür „Wiederherstellen“. */
function buildThumbTile(nb, page, number, opts = {}) {
  const li = document.createElement('li');
  li.className = 'thumb' + (opts.current ? ' current' : '') + (opts.gone ? ' gone' : '');
  li.dataset.page = page.id;
  li._nbId = nb.id;
  const pic = document.createElement(opts.gone ? 'div' : 'button');
  pic.className = 'thumb-pic';
  if (!opts.gone) {
    pic.type = 'button';
    pic.dataset.go = page.id;
    pic.setAttribute('aria-label', `Seite ${number} öffnen`);
    if (opts.current) pic.setAttribute('aria-current', 'page');
  }
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  canvas.setAttribute('aria-hidden', 'true');
  pic.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  const label = document.createElement('span');
  if (opts.gone) {
    const at = isPendingDelete(page) ? _pendingPageOp.at : page.deletedAt;
    label.textContent = deletedAgoText(at);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.dataset.restore = page.id;
    btn.textContent = 'Wiederherstellen';
    btn.setAttribute('aria-label', `Gelöschte Seite wiederherstellen (${label.textContent})`);
    cap.append(label, btn);
  } else {
    label.textContent = `Seite ${number}${opts.current ? ' · aktuell' : ''}`;
    cap.appendChild(label);
  }
  li.append(pic, cap);
  const cached = _thumbCache.get(`${nb.id}/${page.id}`);
  if (cached) paintThumbTile(li, cached);
  return li;
}

/**
 * Übersicht aufbauen bzw. auffrischen. Das Raster entsteht nur neu, wenn sich die Seitenliste
 * geändert hat; sonst werden nur veraltete Vorschauen sichtbarer Kacheln neu eingereiht.
 * Wird von renderUI() und nach Sync-Eingängen aufgerufen — bei geschlossener Übersicht ohne Wirkung.
 */
function refreshPageOverview(force = false) {
  if (!force && !isPageOverviewOpen()) return;
  const nb = currentNotebook();
  const sheet = document.getElementById('pages-sheet');
  const grid = document.getElementById('pages-grid');
  const trash = document.getElementById('pages-trash');
  if (!nb || !sheet || !grid || !trash) return;
  const pages = visiblePages(nb);
  const gone = nb.pages.filter(p => isPageGone(p));
  const currentId = currentPage()?.id;
  const sig = `${nb.id}|${nb.name}|${currentId}|${pages.map(p => p.id).join(',')}|${gone.map(p => p.id).join(',')}`;
  if (sig !== _overviewSig) {
    _overviewSig = sig;
    const hadFocus = sheet.contains(document.activeElement);
    const focusPage = document.activeElement?.closest?.('[data-page]')?.dataset.page;
    document.getElementById('pages-title').textContent = nb.name || 'Notizbuch';
    document.getElementById('pages-count').textContent = `${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'}`;
    _thumbObserver?.disconnect();
    _thumbObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const tile = entry.target;
        tile._visible = entry.isIntersecting;
        if (tile._visible && tile._sig !== thumbSignatureOfTile(tile)) queueThumbTile(tile);
      }
    }, { root: sheet, rootMargin: '200px 0px' });
    _thumbQueue = [];
    const tiles = pages.map((p, i) => buildThumbTile(nb, p, i + 1, { current: p.id === currentId }));
    const add = document.createElement('li');
    add.className = 'thumb';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'new';
    addBtn.id = 'btn-pages-new';
    addBtn.setAttribute('aria-label', 'Neue Seite');
    addBtn.appendChild(svgIcon('plus'));
    const addCap = document.createElement('div');
    addCap.className = 'cap';
    const addLabel = document.createElement('span');
    addLabel.className = 'muted';
    addLabel.textContent = 'Neue Seite';
    addCap.appendChild(addLabel);
    add.append(addBtn, addCap);
    grid.replaceChildren(...tiles, add);
    const goneTiles = gone.map(p => buildThumbTile(nb, p, 0, { gone: true }));
    trash.replaceChildren(...goneTiles);
    document.getElementById('pages-trash-section').hidden = gone.length === 0;
    for (const tile of [...tiles, ...goneTiles]) _thumbObserver.observe(tile);
    // Der Fokus lag auf einem Knopf, den es nicht mehr gibt (z. B. „Wiederherstellen“): in der Übersicht halten
    if (hadFocus && !sheet.contains(document.activeElement)) {
      const tile = [...sheet.querySelectorAll('[data-page]')].find(t => t.dataset.page === focusPage);
      (tile?.querySelector('button') || sheet.querySelector('.thumb.current .thumb-pic') || sheet).focus({ preventScroll: true });
    }
    return;
  }
  for (const tile of sheet.querySelectorAll('.thumb[data-page]')) {
    if (tile._visible && tile._sig !== thumbSignatureOfTile(tile)) queueThumbTile(tile);
  }
}

function thumbSignatureOfTile(tile) {
  const page = state.notebooks.find(n => n.id === tile._nbId)?.pages.find(p => p.id === tile.dataset.page);
  return page ? thumbSignature(page) : tile._sig;
}

/** Seitenübersicht öffnen (Zähler in der Seiten-Pille). */
function openPageOverview() {
  if (!currentNotebook() || isPageOverviewOpen()) return;
  const returnFocus = document.activeElement;
  _overviewSig = '';
  refreshPageOverview(true);
  openDialog('pages-modal', {
    returnFocus,
    focus: '.thumb.current .thumb-pic',
    onClose: () => { _thumbObserver?.disconnect(); _thumbObserver = null; _thumbQueue = []; }
  });
  document.querySelector('#pages-grid .thumb.current')?.scrollIntoView({ block: 'nearest' });
}

/** Tipp in der Übersicht: Seite öffnen, wiederherstellen oder neue Seite anlegen. */
function onPageOverviewClick(e) {
  const go = e.target.closest('[data-go]');
  if (go) {
    closeDialog('pages-modal');
    goToPageId(go.dataset.go);
    return;
  }
  const restore = e.target.closest('[data-restore]');
  if (restore) { restorePage(restore.dataset.restore); return; }
  if (e.target.closest('#btn-pages-new')) addPage();
}

/**
 * Notebook wechseln.
 * @param {string} nbId
 */
async function selectNotebook(nbId) {
  if (nbId === state.currentNotebookId) return;
  await commitPendingPageOp();
  flushSave();
  state.currentNotebookId = nbId;
  ensureCurrentPageId(nbId);
  const page = currentPage();
  if (page) await loadPage(nbId, page.id, page);
  clearAllCanvases();
  redrawBackground();
  fitToContent();
  renderUI();
  saveLocalSettings();
  updateUrlHash();
}

/** Neues Notebook erstellen. */
async function createNotebook() {
  const nbId = newId();
  const pageId = newId();
  const createdAt = Date.now();
  const name = 'Neues Notizbuch';
  state.notebooks.push({
    id: nbId, name,
    pages: [{ id: pageId, strokes: [], background: 'grid', order: 0, createdAt, deletedAt: 0 }]
  });
  state.currentPageIds[nbId] = pageId;
  await saveAppMeta();
  syncSend('nb-created', { eventId: newEventId(), id: nbId, name });
  sendNotebookMeta(nbId);
  await selectNotebook(nbId);
}

/**
 * Notebook löschen.
 * @param {string} nbId
 */
async function deleteNotebook(nbId) {
  if (state.notebooks.length <= 1) return;
  await commitPendingPageOp();
  // Relay: alle Pages des Notebooks löschen
  const nb = state.notebooks.find(n => n.id === nbId);
  if (nb) nb.pages.forEach(p => relayDelete(`p:${nbId}/${p.id}`));
  await deleteNotebookData(nbId);
  state.notebooks = state.notebooks.filter(n => n.id !== nbId);
  delete state.currentPageIds[nbId];
  if (state.currentNotebookId === nbId) {
    state.currentNotebookId = state.notebooks[0].id;
    state.currentPageIds[state.currentNotebookId] = state.notebooks[0]?.pages?.[0]?.id || null;
  }
  await saveAppMeta();
  syncSend('nb-deleted', { eventId: newEventId(), id: nbId });
  const page = currentPage();
  if (page) await loadPage(state.currentNotebookId, page.id, page);
  redrawBackground();
  fitToContent();
  renderUI();
  saveLocalSettings();
  updateUrlHash();
}

/**
 * Notebook umbenennen.
 * @param {string} nbId
 * @param {string} name
 */
async function renameNotebook(nbId, name) {
  const nb = state.notebooks.find(n => n.id === nbId);
  if (!nb) return;
  nb.name = name.trim() || nb.name;
  await saveAppMeta();
  syncSend('nb-renamed', { eventId: newEventId(), id: nbId, name: nb.name });
  renderUI();
}

/** Default-Notebook erstellen (erster Start). */
function createDefaultNotebook() {
  const nbId = newId();
  const pageId = newId();
  state.notebooks = [{
    id: nbId,
    name: `Notizen ${getClientName()}`,
    pages: [{ id: pageId, strokes: [], background: 'grid', order: 0, createdAt: Date.now(), deletedAt: 0 }]
  }];
  state.currentNotebookId = nbId;
  state.currentPageIds[nbId] = pageId;
}

// ─── Undo / Redo / Clear ────────────────────────────────────────────────────

/**
 * Redo-Stapel pro Seite: Schlüssel → IDs der eigenen Undo-Events (oberstes zuletzt).
 * Nur im Speicher — nicht persistiert, nicht synchronisiert. Eingehende
 * Remote-Events verändern ihn nicht.
 * @type {Map<string, string[]>}
 */
const _redoStacks = new Map();

function redoStackKey(notebookId, pageId) {
  return `${notebookId}/${pageId}`;
}

/** Redo-Stapel der aktuellen Seite (leeres Array, wenn keiner existiert). */
function currentRedoStack() {
  const page = currentPage();
  if (!page) return [];
  return _redoStacks.get(redoStackKey(state.currentNotebookId, page.id)) || [];
}

function clearRedoStack(notebookId, pageId) {
  _redoStacks.delete(redoStackKey(notebookId, pageId));
  updateRedoButton();
}

/** Redo-Button nur aktiv, wenn auf der aktuellen Seite etwas wiederholbar ist. */
function updateRedoButton() {
  const btn = document.getElementById('btn-redo');
  if (!btn) return;
  const page = currentPage();
  btn.disabled = !page || isPageGone(page) || !!pendingClearAt(page) || currentRedoStack().length === 0;
}

/** Seite sofort speichern und verteilen (Platte, Relay-Blob, Shared-Room). */
async function persistPage(notebookId, page) {
  const data = await serializePageData(page, notebookId);
  await savePageData(notebookId, page.id, data);
  relayPut(`p:${notebookId}/${page.id}`, data);
  if (state.sharedNotebooks.has(notebookId)) {
    pushSharedNotebook(notebookId, { pageIds: [page.id] }).catch(() => {});
  }
}

/**
 * Eintrag auf den Redo-Stapel legen.
 * @param {{kind: 'undo', eventId: string}|{kind: 'delete', strokeId: string}|{kind: 'group', entries: Array}} entry
 *   'undo' = eigenes undo-Event (Wiederholen hebt es per redo-Event auf);
 *   'delete' = zurückgenommenes Löschen (Wiederholen löscht das Objekt erneut);
 *   'group' = zurückgenommene Gruppenaktion: EIN Eintrag mit je einem Eintrag pro Mitglied
 */
function pushRedoEntry(notebookId, pageId, entry) {
  const stackKey = redoStackKey(notebookId, pageId);
  if (!_redoStacks.has(stackKey)) _redoStacks.set(stackKey, []);
  _redoStacks.get(stackKey).push(entry);
  updateRedoButton();
}

/** Ein einzelnes Seiten-Event über den Live-Weg senden (Nachrichtenform je Aktion wie bisher). */
function sendPageEvent(notebookId, pageId, pageEvent) {
  const base = { eventId: newEventId(), notebookId, pageId };
  if (pageEvent.type === 'stroke') {
    p2pSendForNotebook('stroke', { ...base, stroke: pageEvent.stroke, pageEvent });
    return;
  }
  const extra = pageEvent.type === 'undo' && pageEvent.targetStrokeId ? { strokeId: pageEvent.targetStrokeId } : {};
  p2pSendForNotebook(pageEvent.type, { ...base, ...extra, pageEvent, deviceId: state.deviceId, seq: pageEvent.seq });
}

/** Obergrenzen einer batch-Nachricht (das Relay nimmt höchstens 512 kB Base64 pro Live-Event an) */
const BATCH_MAX_EVENTS = 250;
const BATCH_MAX_CHARS = 150000;

/**
 * Events einer Aktion senden: ein einzelnes wie bisher, mehrere gebündelt als Aktion 'batch'
 * (pageEvents: [...]); sehr große Gruppen in mehreren Nachrichten.
 */
function sendPageEvents(notebookId, pageId, events) {
  if (!events.length) return;
  if (events.length === 1) { sendPageEvent(notebookId, pageId, events[0]); return; }
  let chunk = [], chars = 0;
  const flush = () => {
    if (!chunk.length) return;
    p2pSendForNotebook('batch', { eventId: newEventId(), notebookId, pageId, pageEvents: chunk, deviceId: state.deviceId });
    chunk = [];
    chars = 0;
  };
  for (const event of events) {
    const len = JSON.stringify(event).length;
    if (chunk.length && (chunk.length >= BATCH_MAX_EVENTS || chars + len > BATCH_MAX_CHARS)) flush();
    chunk.push(event);
    chars += len;
  }
  flush();
}

/**
 * Letzte Aktion der Seite zurücknehmen (siehe lastPageAction):
 *  - Objekt gezeichnet → undo-Event mit targetStrokeId (wie bisher)
 *  - Objekt geändert   → undo-Event mit targetEventId (hebt genau diesen edit auf)
 *  - Objekt gelöscht   → redo-Event auf das Lösch-Event (das Objekt kommt zurück)
 *  - Gruppe            → je Mitglied das passende Gegen-Event, alle mit einer gemeinsamen groupId;
 *                        ein Speichervorgang, eine Nachricht, EIN Eintrag im Redo-Stapel
 */
async function undo() {
  flushNudge();
  const page = currentPage();
  if (!page || isPageGone(page)) return;
  const action = lastPageAction(page);
  if (!action) return;
  const notebookId = state.currentNotebookId;
  const members = action.kind === 'group' ? action.members : [action];
  const group = members.length > 1 ? { groupId: newId() } : {};
  const events = [], entries = [];
  for (const m of members) {
    let pageEvent;
    if (m.kind === 'stroke') {
      pageEvent = newPageEvent('undo', { targetStrokeId: m.stroke.id, ...group });
      entries.push({ kind: 'undo', eventId: pageEvent.id });
    } else if (m.kind === 'edit') {
      pageEvent = newPageEvent('undo', { targetEventId: m.event.id, ...group });
      entries.push({ kind: 'undo', eventId: pageEvent.id });
    } else {
      pageEvent = newPageEvent('redo', { targetEventId: m.event.id, ...group });
      entries.push({ kind: 'delete', strokeId: m.event.targetStrokeId });
    }
    events.push(pageEvent);
  }
  applyPageEvents(page, events);
  redrawStrokes();
  // Eigenes Rückgängig für Redo merken
  pushRedoEntry(notebookId, page.id, entries.length > 1 ? { kind: 'group', entries } : entries[0]);
  await persistPage(notebookId, page);
  sendPageEvents(notebookId, page.id, events);
}

/** Letztes eigenes Rückgängig der aktuellen Seite aufheben (eine Gruppe als Ganzes). */
async function redo() {
  flushNudge();
  const page = currentPage();
  if (!page || isPageGone(page)) return;
  const notebookId = state.currentNotebookId;
  const stack = _redoStacks.get(redoStackKey(notebookId, page.id));
  if (!stack || stack.length === 0 || pendingClearAt(page)) return;
  const entry = stack.pop();
  updateRedoButton();
  const entries = entry.kind === 'group' ? entry.entries : [entry];
  const group = entries.length > 1 ? { groupId: newId() } : {};
  const visibleIds = entries.some(en => en.kind === 'delete') ? new Set(materializePage(page).map(s => s.id)) : null;
  const events = [];
  for (const en of entries) {
    if (en.kind === 'delete') {
      // Zurückgenommenes Löschen wiederholen: neues Lösch-Event — nur wenn es das Objekt noch gibt
      if (!visibleIds.has(en.strokeId)) continue;
      events.push(newPageEvent('undo', { targetStrokeId: en.strokeId, reason: 'delete', ...group }));
    } else {
      events.push(newPageEvent('redo', { targetEventId: en.eventId, ...group }));
    }
  }
  if (!events.length) return;
  applyPageEvents(page, events);
  redrawStrokes();
  await persistPage(notebookId, page);
  sendPageEvents(notebookId, page.id, events);
}

/** Aktuelle Seite leeren — mit „Rückgängig“ im Hinweis. Der Redo-Stapel wird beim Festschreiben geleert. */
function clearPage() {
  startPendingPageOp('clear');
}

// ─── Formen ─────────────────────────────────────────────────────────────────

/** Form für das Werkzeug „Formen“ wählen (Popover am Werkzeug-Knopf). */
function setShapeType(type) {
  if (!SHAPE_TYPES.includes(type)) return;
  state.shapeType = type;
  saveLocalSettings();
  setTool('shape');
}

/**
 * Geometrie aus Anfangs- und Endpunkt des Aufziehens.
 * @param {boolean} constrain - Umschalt gehalten: Quadrat/Kreis bzw. Linie in 45°-Schritten
 */
function shapeFromDrag(a, b, type, constrain) {
  let x2 = b.x, y2 = b.y;
  const dx = x2 - a.x, dy = y2 - a.y;
  if (constrain) {
    if (type === 'line' || type === 'arrow') {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      x2 = a.x + len * Math.cos(ang);
      y2 = a.y + len * Math.sin(ang);
    } else {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      x2 = a.x + m * (Math.sign(dx) || 1);
      y2 = a.y + m * (Math.sign(dy) || 1);
    }
  }
  return roundShape({ type, x1: a.x, y1: a.y, x2, y2 });
}

/** Form als Strich-Objekt: tool 'shape' + Geometrie, dazu der Umriss in points für alte Versionen. */
function newShapeStroke(shape) {
  const size = PEN_SIZES[state.penSizeIndex].size;
  return {
    id: newId(),
    createdAt: Date.now(),
    points: shapeOutlinePoints(shape, size),
    color: state.color,
    size,
    tool: 'shape',
    shape,
    fill: null
  };
}

// ─── Füllen ─────────────────────────────────────────────────────────────────
// Werkzeug „Füllen“: Ein Tipp füllt die geschlossene Fläche unter dem Zeiger. Das Ergebnis ist eine
// Vektorfläche (stroke mit tool:'fill' und polys) — ein Objekt wie Strich und Form. Gesucht wird die
// Fläche auf einem Hilfs-Canvas (nicht im DOM), das den Ausschnitt plus Rand zeigt.

/** Pixelbudget des Hilfs-Canvas */
const FILL_PIXEL_BUDGET = 6000000;
/** Höchstzahl Punkte einer Füllfläche über alle Ringe — darüber wird gröber vereinfacht */
const FILL_MAX_POINTS = 3000;
/** Vereinfachung der Ränder: erlaubte Abweichung in Pixeln des Hilfs-Canvas */
const FILL_SIMPLIFY_TOL = 0.75;
const FILL_HINT_OPEN = 'Fläche ist nicht geschlossen – schon eine kleine Lücke in der Umrandung genügt. Bei sehr großen Flächen hilft Herauszoomen.';

let _fillProbeCanvas = null;
/** @type {{pointerId: number, pos: {x: number, y: number}}|null} begonnener Tipp im Werkzeug „Füllen“ */
let _fillTap = null;
/** Letzte Messung für das Diagnose-Overlay */
let _lastFillInfo = '';

/**
 * Striche (ohne Papier/Raster) in das Hilfs-Canvas zeichnen und die Fläche unter world suchen.
 * @param {number} scale - Pixel je Welteinheit
 * @param {number} margin - Rand je Seite als Anteil der Ausschnittgröße
 */
function runFillProbe(strokes, world, scale, margin) {
  const container = document.getElementById('canvas-container');
  const k = state.viewScale;
  const vw = container.clientWidth / k, vh = container.clientHeight / k;
  const ox = -state.viewX / k - vw * margin, oy = -state.viewY / k - vh * margin;
  const W = Math.max(3, Math.ceil(vw * (1 + 2 * margin) * scale));
  const H = Math.max(3, Math.ceil(vh * (1 + 2 * margin) * scale));
  if (!_fillProbeCanvas) _fillProbeCanvas = document.createElement('canvas');
  const canvas = _fillProbeCanvas;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);
  ctx.setTransform(scale, 0, 0, scale, -ox * scale, -oy * scale);
  for (const s of strokes) drawStrokeToCanvas(ctx, s);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  const t1 = performance.now();
  const data = ctx.getImageData(0, 0, W, H).data;
  const t2 = performance.now();
  const res = traceFillRegion(data, W, H, Math.floor((world.x - ox) * scale), Math.floor((world.y - oy) * scale));
  return { res, ox, oy, scale, W, H, readMs: t2 - t1, traceMs: performance.now() - t2 };
}

/** Liegt der Punkt im Inneren eines Rechtecks/einer Ellipse (ohne die Kontur)? */
function insideShapeArea(stroke, world) {
  const { type, x1, y1, x2, y2 } = stroke.shape;
  const half = (stroke.size || 1) / 2;
  if (type === 'rect') {
    return world.x > Math.min(x1, x2) + half && world.x < Math.max(x1, x2) - half
      && world.y > Math.min(y1, y2) + half && world.y < Math.max(y1, y2) - half;
  }
  const rx = Math.abs(x2 - x1) / 2 - half, ry = Math.abs(y2 - y1) / 2 - half;
  if (!(rx > 0 && ry > 0)) return false;
  const nx = (world.x - (x1 + x2) / 2) / rx, ny = (world.y - (y1 + y2) / 2) / ry;
  return nx * nx + ny * ny < 1;
}

/**
 * Füllen an einer Stelle der Zeichenfläche (Bildschirm-Koordinaten im Container).
 *  - Pixel unter dem Zeiger belegt: Liegt dort oben eine Füllfläche bzw. das Innere einer gefüllten
 *    Form, wird sie umgefärbt (edit-Event, kein neues Objekt); sonst Hinweis.
 *  - Pixel frei: Flutfüllung. Erreicht sie den Rand des Hilfs-Canvas, gilt die Fläche als offen.
 *    Sonst entsteht ein neues Objekt (stroke-Event) — verteilt wie jeder Strich.
 */
function fillAtPoint(pos) {
  const page = currentPage();
  const container = document.getElementById('canvas-container');
  if (!page || !container || isPageGone(page)) return;
  const t0 = performance.now();
  const world = screenToWorld(pos.x, pos.y);
  const strokes = materializePage(page);
  if (!strokes.length) { showToast(FILL_HINT_OPEN, { key: 'fill', dauer: 4500 }); return; }

  // Auflösung = Bildschirm (inkl. DPR); der Rand je Seite richtet sich nach dem Pixelbudget (höchstens 50 %)
  const viewPx = container.clientWidth * DPR * container.clientHeight * DPR;
  let scale = state.viewScale * DPR;
  let margin = 0;
  if (viewPx > FILL_PIXEL_BUDGET) scale *= Math.sqrt(FILL_PIXEL_BUDGET / viewPx);
  else margin = Math.min(0.5, (Math.sqrt(FILL_PIXEL_BUDGET / viewPx) - 1) / 2);
  let probe = runFillProbe(strokes, world, scale, margin);
  let stage = 1;
  if (probe.res.status === 'open' && margin < 0.4) {
    // Zweiter Versuch mit vollem Rand, dafür gröber: die Fläche darf über den Ausschnitt hinausreichen
    const coarse = scale * Math.sqrt(FILL_PIXEL_BUDGET / (4 * Math.min(viewPx, FILL_PIXEL_BUDGET)));
    const second = runFillProbe(strokes, world, Math.min(scale, coarse), 0.5);
    stage = 2;
    if (second.res.status !== 'ok') second.res = { status: 'open' };
    second.readMs += probe.readMs;
    second.traceMs += probe.traceMs;
    probe = second;
  }
  const { res } = probe;
  const note = extra => {
    _lastFillInfo = `${Math.round(performance.now() - t0)} ms (${res.status}, ${probe.W}×${probe.H}, stufe ${stage}, lesen ${Math.round(probe.readMs)}, suchen ${Math.round(probe.traceMs)}${extra || ''})`;
    updateSyncDebug();
  };

  if (res.status === 'solid') {
    const hit = hitTestObjects(world, 0);
    const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
    if (hit?.tool === 'fill') {
      if (!same(hit.color, state.color)) commitEdit(state.currentNotebookId, page, hit.id, { color: state.color });
    } else if (hit?.tool === 'shape' && hit.fill && (hit.shape?.type === 'rect' || hit.shape?.type === 'ellipse') && insideShapeArea(hit, world)) {
      if (!same(hit.fill, state.color)) commitEdit(state.currentNotebookId, page, hit.id, { fill: state.color });
    } else {
      showToast('Zum Füllen in eine Fläche tippen', { key: 'fill' });
    }
    note();
    return;
  }
  if (res.status === 'open') { showToast(FILL_HINT_OPEN, { key: 'fill', dauer: 4500 }); note(); return; }
  if (res.status === 'tiny') { showToast('Fläche ist zu klein zum Füllen', { key: 'fill' }); note(); return; }

  // Ränder vereinfachen; bei zu vielen Punkten gröber
  let tol = FILL_SIMPLIFY_TOL, rings, total;
  for (;;) {
    rings = res.rings.map(r => simplifyRing(r, tol)).filter(r => r.length >= 6);
    total = rings.reduce((n, r) => n + r.length / 2, 0);
    if (total <= FILL_MAX_POINTS || tol > 6) break;
    tol *= 1.5;
  }
  const r1 = v => Math.round(v * 10) / 10;
  const polys = [];
  for (const ring of rings) {
    const pts = [];
    for (let i = 0; i < ring.length; i += 2) {
      const p = { x: r1(probe.ox + ring[i] / probe.scale), y: r1(probe.oy + ring[i + 1] / probe.scale) };
      const last = pts[pts.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) pts.push(p);
    }
    if (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts.pop();
    if (pts.length >= 3) polys.push(pts);
    else if (!polys.length) break; // Außenkontur entartet
  }
  if (!polys.length) { showToast('Fläche ist zu klein zum Füllen', { key: 'fill' }); note(); return; }

  // Ein neues Objekt schreibt ein vorgemerktes Leeren sofort fest (wie ein neuer Strich)
  if (_pendingPageOp) commitPendingPageOp();
  const newStroke = {
    id: newId(),
    createdAt: Date.now(),
    points: fillOutlinePoints(polys),
    color: state.color,
    size: 1,
    tool: 'fill',
    polys
  };
  const pageEvent = newPageEvent('stroke', { stroke: newStroke });
  applyPageEvent(page, pageEvent);
  clearRedoStack(state.currentNotebookId, page.id);
  redrawStrokes();
  saveCurrentPage();
  p2pSendForNotebook('stroke', { eventId: newEventId(), notebookId: state.currentNotebookId, pageId: page.id, stroke: newStroke, pageEvent });
  note(`, ringe ${polys.length}, punkte ${polys.reduce((n, r) => n + r.length, 0)}, toleranz ${Math.round(tol * 100) / 100}`);
}

// ─── Auswahl ────────────────────────────────────────────────────────────────
// Rein lokal (nicht synchronisiert). Ein oder mehrere Objekte; Rahmen und Griffe liegen auf
// activeCanvas — dort wird im Werkzeug „Auswahl“ nicht gezeichnet. Änderungen entstehen beim
// Loslassen: EIN edit-Event je Objekt, bei mehreren Objekten mit gemeinsamer groupId (eine Aktion).
// Solange gezogen wird, zeigt _selPreview die Änderung nur auf diesem Gerät.

/** Rahmenfarbe: Petrol in beiden Themes — das Papier ist immer weiß. */
const SELECT_COLOR = '#0b7285';
const SELECT_TINT = 'rgba(11, 114, 133, 0.1)';
const SELECT_HANDLES = [['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5]];
/** Unter dieser Größe am Bildschirm entfallen die Kantenmitte-Griffe der Richtung; Ziehen im Rahmen verschiebt */
const SELECT_SMALL_PX = 60;
/** Mindestlänge von Linie/Pfeil beim Ziehen eines Endpunkts (Bildschirm-Pixel) */
const LINE_MIN_PX = 4;
const IDENTITY_TRANSFORM = [1, 1, 0, 0];

/** @type {{pageKey: string, ids: string[]}|null} */
let _selection = null;
/** Umschalter „Mehrere“ der Leiste: jeder Tipp fügt hinzu/entfernt (für Touch ohne Tastatur) */
let _selMulti = false;
/**
 * Lokale Vorschau beim Ziehen / Schieben per Taste:
 *  - { g, t0 }: gemeinsame Abbildung g = [sx, sy, tx, ty] der gewählten Objekte, t0 = Map id → transform beim Start
 *  - { strokeId, shape }: neue Grundgeometrie einer Linie/eines Pfeils (Endpunkt-Griff)
 * @type {Object|null}
 */
let _selPreview = null;
/** @type {Object|null} laufende Zieh-Geste */
let _selDrag = null;
/** @type {Object|null} gesammelte Pfeiltasten-Schritte, die zu einer Aktion werden */
let _nudge = null;
/** @type {{x0: number, y0: number, x1: number, y1: number}|null} Auswahlrechteck beim Aufziehen (Bildschirm) */
let _marquee = null;
/** Zuletzt gezeichnete Objekte der aktuellen Seite (inkl. Vorschau) — für Rahmen und Treffertest */
let _displayStrokes = [];
/** @type {Map<string, Object>} dieselben Objekte nach ID (nur gefüllt, solange etwas gewählt ist) */
let _displayIndex = new Map();
let _selOverlayShown = false;
let _selRedrawQueued = false;
/** Diagnose-Overlay: Zeile „auswahl: …“ und letzte Messung beim Ziehen */
let _selDebugLine = 'auswahl: 0';
let _selTimingInfo = '';
let _pageDetailMemo = null;

/**
 * materializePageDetailed mit Merker: Solange sich das Event-Log (nur Anhängen) und das Leeren nicht
 * ändern, wird nicht neu aufgebaut — beim Ziehen also einmal, nicht pro Bild.
 */
function pageDetail(page) {
  ensurePageEvents(page);
  const cleared = Math.max(page.clearedAt || 0, pendingClearAt(page));
  const m = _pageDetailMemo;
  if (m && m.page === page && m.events === page.events && m.count === page.events.length && m.cleared === cleared) return m.det;
  const det = materializePageDetailed(page);
  det.byId = new Map(det.strokes.map(s => [s.id, s]));
  _pageDetailMemo = { page, events: page.events, count: page.events.length, cleared, det };
  return det;
}

/** g ∘ t: erst t (Ursprung → jetzige Lage), dann die gemeinsame Abbildung g der Auswahl. */
function composeTransform(g, t) {
  return [g[0] * t[0], g[1] * t[1], g[0] * t[2] + g[2], g[1] * t[3] + g[3]];
}

function isLineShape(stroke) {
  return stroke?.tool === 'shape' && (stroke.shape?.type === 'line' || stroke.shape?.type === 'arrow');
}

function isFillableShape(stroke) {
  return stroke?.tool === 'shape' && (stroke.shape?.type === 'rect' || stroke.shape?.type === 'ellipse');
}

/** Objekte für die Anzeige: materialisierte Seite, die gewählten Objekte ggf. mit lokaler Vorschau. */
function displayStrokes(page) {
  if (!page) { if (_selection) dropSelection(true); _displayStrokes = []; _displayIndex = new Map(); return _displayStrokes; }
  const det = pageDetail(page);
  let strokes = det.strokes;
  if (_selection) {
    // Auswahl verschwindet mit ihren Objekten (Seitenwechsel, Leeren, Löschen — auch von einem anderen
    // Gerät). Fällt nur ein Teil weg, bleibt der Rest gewählt.
    const ids = _selection.pageKey === pageKey() ? _selection.ids.filter(id => det.byId.has(id)) : [];
    if (!ids.length) dropSelection(true);
    else if (ids.length !== _selection.ids.length) _selection.ids = ids;
  }
  if (_selection && _selPreview) {
    const preview = new Map();
    const pv = _selPreview;
    if (pv.shape) {
      const base = det.baseById.get(pv.strokeId);
      if (base && _selection.ids.includes(pv.strokeId)) {
        preview.set(pv.strokeId, applyStrokePatch(base, { ...det.patches.get(pv.strokeId), shape: pv.shape, transform: IDENTITY_TRANSFORM }));
      }
    } else {
      for (const id of _selection.ids) {
        const patch = det.patches.get(id);
        const t0 = pv.t0.get(id) || patch?.transform || IDENTITY_TRANSFORM;
        preview.set(id, applyStrokePatch(det.baseById.get(id), { ...patch, transform: composeTransform(pv.g, t0) }));
      }
    }
    if (preview.size) strokes = strokes.map(s => preview.get(s.id) || s);
  }
  _displayStrokes = strokes;
  _displayIndex = _selection ? new Map(strokes.map(s => [s.id, s])) : new Map();
  return strokes;
}

/** Gewählte Objekte (in Stapelfolge) mit ihrer aktuellen Abbildung — oder null. */
function selectionInfo() {
  const page = currentPage();
  if (!_selection || !page || _selection.pageKey !== pageKey()) return null;
  const det = pageDetail(page);
  const chosen = new Set(_selection.ids);
  const items = [];
  for (const stroke of det.strokes) {
    if (chosen.has(stroke.id)) items.push({ id: stroke.id, stroke, transform: det.patches.get(stroke.id)?.transform || IDENTITY_TRANSFORM });
  }
  if (!items.length) return null;
  return { notebookId: state.currentNotebookId, page, items };
}

/**
 * Auswahl setzen (ersetzt die bisherige). Leere Liste hebt auf.
 * @param {string[]} ids
 */
function selectStrokes(ids) {
  flushNudge();
  const unique = [...new Set(ids)];
  if (!unique.length) { dropSelection(); return; }
  const hadPreview = !!_selPreview;
  _selection = { pageKey: pageKey(), ids: unique };
  _selPreview = null;
  closePopovers();
  // Der Index der angezeigten Objekte gehört zur Auswahl
  _displayIndex = new Map(_displayStrokes.map(s => [s.id, s]));
  if (hadPreview) redrawStrokes(); else drawSelectionOverlay();
}

function selectStroke(strokeId) {
  selectStrokes([strokeId]);
}

/** Objekt zur Auswahl hinzufügen bzw. herausnehmen (Umschalt/Strg+Klick, Umschalter „Mehrere“). */
function toggleSelected(strokeId) {
  const ids = _selection?.pageKey === pageKey() ? _selection.ids : [];
  const multi = _selMulti;
  selectStrokes(ids.includes(strokeId) ? ids.filter(id => id !== strokeId) : [...ids, strokeId]);
  // Der Umschalter überlebt das Hinzufügen; ohne Auswahl gibt es auch keine Leiste mehr
  if (multi && _selection) setSelMulti(true);
}

/** Alle Objekte der Seite wählen (Strg/Cmd+A); Radierer-Striche nie. */
function selectAllObjects() {
  const page = currentPage();
  if (!page || isPageGone(page)) return;
  selectStrokes(pageDetail(page).strokes.filter(s => s.tool !== 'eraser' && strokeGeomBounds(s)).map(s => s.id));
}

/** Umschalter „Mehrere“ setzen (nur lokal, endet mit der Auswahl). */
function setSelMulti(on) {
  _selMulti = !!on;
  document.getElementById('btn-sel-multi')?.setAttribute('aria-pressed', String(_selMulti));
  refreshSelDebug();
}

/**
 * Auswahl aufheben.
 * @param {boolean} [fromRedraw] - Aufruf aus dem Neuzeichnen heraus: dort nicht erneut zeichnen
 */
function dropSelection(fromRedraw = false) {
  const marqueeDrag = !!_selDrag && (_selDrag.mode === 'marquee' || _selDrag.mode === 'marquee-pending');
  // Ein laufendes Aufziehen des Auswahlrechtecks hängt nicht an der Auswahl — es endet nur, wenn
  // ausdrücklich aufgehoben wird (Esc, Werkzeugwechsel), nicht beim Neuzeichnen
  const hadMarquee = !fromRedraw && !!_marquee;
  if (!fromRedraw || !marqueeDrag) _selDrag = null;
  if (!fromRedraw) _marquee = null;
  if (!_selection && !_selPreview && !_nudge) { if (hadMarquee) drawSelectionOverlay(); return; }
  const hadPreview = !!_selPreview;
  // Noch nicht festgeschriebene Pfeiltasten-Schritte gehören zur alten Seite — nach dem Zeichnen nachholen
  if (_nudge) queueMicrotask(flushNudge);
  _selection = null;
  _selPreview = null;
  if (_selMulti) setSelMulti(false);
  if (fromRedraw) return;
  if (hadPreview) redrawStrokes(); else drawSelectionOverlay();
}

/**
 * Rahmen der Auswahl in Bildschirm-Koordinaten (mit etwas Abstand zu den Objekten) — bei mehreren
 * Objekten EIN gemeinsamer Rahmen. Ist genau eine Linie/ein Pfeil gewählt, stehen in `line` die
 * beiden Endpunkte (dann gibt es Endpunkt-Griffe statt des Rahmens).
 */
function selectionFrame() {
  if (!_selection) return null;
  const k = state.viewScale;
  const strokes = [], bounds = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (const id of _selection.ids) {
    const stroke = _displayIndex.get(id);
    const b = stroke ? strokeGeomBounds(stroke) : null;
    if (!b) continue;
    const pad = 6 + (stroke.size || 1) * k / 2;
    x0 = Math.min(x0, b.minX * k + state.viewX - pad);
    y0 = Math.min(y0, b.minY * k + state.viewY - pad);
    x1 = Math.max(x1, b.maxX * k + state.viewX + pad);
    y1 = Math.max(y1, b.maxY * k + state.viewY + pad);
    gx0 = Math.min(gx0, b.minX); gy0 = Math.min(gy0, b.minY);
    gx1 = Math.max(gx1, b.maxX); gy1 = Math.max(gy1, b.maxY);
    strokes.push(stroke);
    bounds.push(b);
  }
  if (!strokes.length) return null;
  const single = strokes.length === 1 ? strokes[0] : null;
  const line = isLineShape(single) ? {
    p1: { x: single.shape.x1 * k + state.viewX, y: single.shape.y1 * k + state.viewY },
    p2: { x: single.shape.x2 * k + state.viewX, y: single.shape.y2 * k + state.viewY }
  } : null;
  return {
    strokes, bounds, stroke: strokes[0], line, x0, y0, x1, y1,
    geom: { minX: gx0, minY: gy0, maxX: gx1, maxY: gy1 },
    smallX: (gx1 - gx0) * k < SELECT_SMALL_PX, smallY: (gy1 - gy0) * k < SELECT_SMALL_PX
  };
}

/** Griffe des Rahmens: bei kleinen Objekten entfallen die Kantenmitte-Griffe (oben/unten bzw. links/rechts). */
function frameHandles(frame) {
  return SELECT_HANDLES.filter(([name]) => name.length === 2 || (name === 'n' || name === 's' ? !frame.smallX : !frame.smallY));
}

/** Zeile fürs Diagnose-Overlay: „auswahl: N (art, G griffe)“. */
function refreshSelDebug(frame = selectionFrame()) {
  let line = 'auswahl: 0';
  if (frame) {
    const s = frame.stroke;
    const kind = frame.strokes.length > 1 ? 'gruppe'
      : s.tool === 'shape' ? ({ line: 'linie', arrow: 'pfeil', rect: 'rechteck', ellipse: 'ellipse' }[s.shape?.type] || 'form')
      : s.tool === 'fill' ? 'fläche' : 'stift';
    line = `auswahl: ${frame.strokes.length} (${kind}, ${frame.line ? 2 : frameHandles(frame).length} griffe${_selMulti ? ', mehrere' : ''})`;
  }
  if (line === _selDebugLine) return;
  _selDebugLine = line;
  updateSyncDebug();
}

/**
 * Auswahl auf activeCanvas zeichnen und die Leiste nachführen: Rahmen mit Griffen (bei mehreren Objekten
 * zusätzlich jedes Objekt dünn umrandet), Endpunkt-Griffe bei Linie/Pfeil, Auswahlrechteck beim Aufziehen.
 */
function drawSelectionOverlay() {
  if (!activeCtx || !activeCanvas || isDrawing) return;
  const frame = selectionFrame();
  const marquee = _marquee;
  if (!frame && !marquee && !_selOverlayShown) { refreshSelDebug(null); return; }
  const ctx = activeCtx;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, activeCanvas.width / DPR, activeCanvas.height / DPR);
  _selOverlayShown = !!(frame || marquee);
  updateSelbar(frame);
  refreshSelDebug(frame);
  if (!frame && !marquee) return;
  const k = state.viewScale;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = SELECT_COLOR;
  ctx.fillStyle = '#ffffff';
  if (frame && frame.line) {
    // Linie/Pfeil: dezente Hervorhebung entlang der Linie, runde Griffe an beiden Enden
    const { p1, p2 } = frame.line;
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.lineCap = 'round';
    ctx.lineWidth = (frame.stroke.size || 1) * k + 8;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.restore();
    ctx.lineWidth = 2;
    for (const p of [p1, p2]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  } else if (frame) {
    if (frame.strokes.length > 1) {
      // Jedes gewählte Objekt dünn hervorheben
      ctx.save();
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < frame.strokes.length; i++) {
        const b = frame.bounds[i];
        const pad = 2 + (frame.strokes[i].size || 1) * k / 2;
        ctx.rect(b.minX * k + state.viewX - pad, b.minY * k + state.viewY - pad, (b.maxX - b.minX) * k + 2 * pad, (b.maxY - b.minY) * k + 2 * pad);
      }
      ctx.stroke();
      ctx.restore();
    }
    const w = frame.x1 - frame.x0, h = frame.y1 - frame.y0;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 6]);
    ctx.strokeRect(frame.x0, frame.y0, w, h);
    ctx.setLineDash([]);
    for (const [, fx, fy] of frameHandles(frame)) {
      const x = frame.x0 + w * fx, y = frame.y0 + h * fy;
      ctx.fillRect(x - 6, y - 6, 12, 12);
      ctx.strokeRect(x - 6, y - 6, 12, 12);
    }
  }
  if (marquee) {
    const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
    const w = Math.abs(marquee.x1 - marquee.x0), h = Math.abs(marquee.y1 - marquee.y0);
    ctx.fillStyle = SELECT_TINT;
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** Farbfelder in einem Popover der Auswahl-Leiste (Palette + eigene Farben). */
function renderSelSwatches(box, current) {
  if (!box) return;
  const custom = state.customColors.filter(c => !COLORS.includes(c) && /^#[0-9a-f]{3,8}$/i.test(c));
  const listKey = custom.join(',');
  if (box.dataset.key !== listKey || !box.firstElementChild) {
    box.dataset.key = listKey;
    box.replaceChildren(...[...COLORS, ...custom].map((c, i) => {
      const name = i < COLORS.length ? COLOR_NAMES[i] : `Eigene Farbe ${c}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch';
      btn.style.setProperty('--c', c);
      btn.dataset.color = c;
      btn.title = name;
      btn.setAttribute('aria-label', name);
      btn.appendChild(document.createElement('i'));
      return btn;
    }));
  }
  const cur = String(current || '').toLowerCase();
  box.querySelectorAll('.swatch').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.color === cur)));
}

/** Gemeinsamer Wert aller Einträge — oder undefined, wenn sie sich unterscheiden. */
function commonValue(values) {
  const first = values[0];
  return values.every(v => v === first) ? first : undefined;
}

/**
 * Kleine Leiste an der Auswahl: Farbe, Füllung (nur wenn ein Rechteck/eine Ellipse dabei ist), Duplizieren,
 * Löschen, Umschalter „Mehrere“; bei mehreren Objekten die Anzahl.
 */
function updateSelbar(frame = selectionFrame()) {
  const bar = document.getElementById('selbar');
  const container = document.getElementById('canvas-container');
  if (!bar || !container) return;
  const dragging = !!_selDrag && _selDrag.mode !== 'pending' && _selDrag.mode !== 'marquee-pending';
  if (!frame || dragging) {
    if (!bar.hidden) {
      if (bar.querySelector('[data-pop]:not([hidden])')) closePopovers();
      bar.hidden = true;
    }
    return;
  }
  const strokes = frame.strokes;
  const n = strokes.length;
  const fillables = strokes.filter(isFillableShape);
  // Die Leiste ändert sich nur mit Auswahl, Farben und eigener Farbliste — beim Bewegen der Ansicht nur die Lage
  const sig = n + '|' + _selMulti + '|' + state.customColors.join(',') + '|' + strokes.map(s => `${s.id}:${s.color}:${s.fill || ''}`).join('|');
  if (bar.dataset.sig !== sig) {
    bar.dataset.sig = sig;
    const fillWrap = document.getElementById('sel-fill-wrap');
    if (fillWrap) fillWrap.hidden = !fillables.length;
    const chip = document.getElementById('sel-chip-color');
    if (chip) chip.style.background = strokes[0].color || '#000000';
    renderSelSwatches(document.getElementById('sel-color-swatches'), commonValue(strokes.map(s => String(s.color || '').toLowerCase())));
    renderSelSwatches(document.getElementById('sel-fill-swatches'), fillables.length ? commonValue(fillables.map(s => String(s.fill || '').toLowerCase())) : '');
    document.getElementById('btn-sel-nofill')?.setAttribute('aria-pressed', String(fillables.length > 0 && fillables.every(s => !s.fill)));
    const count = document.getElementById('sel-count');
    if (count) { count.hidden = n < 2; count.textContent = `${n} Objekte`; }
    document.getElementById('btn-sel-multi')?.setAttribute('aria-pressed', String(_selMulti));
    document.getElementById('btn-sel-delete')?.setAttribute('aria-label', n > 1 ? `${n} Objekte löschen` : 'Objekt löschen');
  }
  bar.hidden = false;
  // Über dem Rahmen, sonst darunter; immer ganz im Bild
  const cw = container.clientWidth, ch = container.clientHeight;
  const bw = bar.offsetWidth, bh = bar.offsetHeight, gap = 14;
  let top = frame.y0 - bh - gap;
  if (top < 4) top = frame.y1 + gap;
  if (top + bh > ch - 4) top = Math.max(4, Math.min(ch - bh - 4, frame.y0 + gap));
  const left = Math.max(4, Math.min(cw - bw - 4, (frame.x0 + frame.x1) / 2 - bw / 2));
  bar.style.left = Math.round(left) + 'px';
  bar.style.top = Math.round(top) + 'px';
}

/** Popover der Auswahl-Leiste so legen, dass es ganz in der Zeichenfläche bleibt. */
function placeSelPopover(pop) {
  const container = document.getElementById('canvas-container');
  if (!pop || pop.hidden || !container) return;
  pop.classList.remove('up');
  pop.style.left = '0px';
  const c = container.getBoundingClientRect();
  let r = pop.getBoundingClientRect();
  if (r.bottom > c.bottom - 4 && r.top - c.top > c.bottom - r.bottom) { pop.classList.add('up'); r = pop.getBoundingClientRect(); }
  let shift = 0;
  if (r.right > c.right - 4) shift = c.right - 4 - r.right;
  if (r.left + shift < c.left + 4) shift = c.left + 4 - r.left;
  pop.style.left = Math.round(shift) + 'px';
}

/**
 * Oberstes sichtbares Objekt an einem Punkt (Weltkoordinaten); Radierer-Striche zählen nicht.
 * Reihenfolge wie im Bild: Füllflächen liegen unter allen Strichen und Formen (auch unter älteren —
 * 'destination-over'), und unter den Füllflächen liegt die ältere oben.
 */
function hitTestObjects(world, tol) {
  for (let i = _displayStrokes.length - 1; i >= 0; i--) {
    const s = _displayStrokes[i];
    if (s.tool !== 'fill' && hitTestStroke(s, world.x, world.y, tol)) return s;
  }
  for (const s of _displayStrokes) {
    if (s.tool === 'fill' && hitTestStroke(s, world.x, world.y, tol)) return s;
  }
  return null;
}

/** Objekte, deren Geometrie-Grenzen ein Rechteck (Weltkoordinaten) schneiden; Radierer-Striche nie. */
function objectsInRect(r) {
  const ids = [];
  for (const s of _displayStrokes) {
    if (s.tool === 'eraser') continue;
    const b = strokeGeomBounds(s);
    if (b && b.maxX >= r.minX && b.minX <= r.maxX && b.maxY >= r.minY && b.minY <= r.maxY) ids.push(s.id);
  }
  return ids;
}

/**
 * Griff unter dem Zeiger. Nach außen gilt die volle Toleranz, nach innen höchstens ein Viertel des Rahmens —
 * bei kleinen Objekten gar nichts: dort verschiebt Ziehen im Rahmen immer.
 */
function hitSelectionHandle(frame, pos, tol) {
  const w = frame.x1 - frame.x0, h = frame.y1 - frame.y0;
  const inX = frame.smallX ? 0 : Math.min(tol, w / 4), inY = frame.smallY ? 0 : Math.min(tol, h / 4);
  const within = (d, f, inner) => f === 0 ? (d >= -tol && d <= inner) : f === 1 ? (d <= tol && d >= -inner) : Math.abs(d) <= inner;
  let best = null, bestDist = Infinity;
  for (const [name, fx, fy] of frameHandles(frame)) {
    const dx = pos.x - (frame.x0 + w * fx), dy = pos.y - (frame.y0 + h * fy);
    if (!within(dx, fx, inX) || !within(dy, fy, inY)) continue;
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) { best = name; bestDist = dist; }
  }
  return best;
}

/**
 * Endpunkt-Griff einer Linie/eines Pfeils unter dem Zeiger: 1 (x1/y1), 2 (x2/y2) oder 0.
 * Bei kurzen Linien schrumpft die Trefferfläche auf ein Drittel der Länge — die Mitte bleibt zum Verschieben.
 */
function hitLineEnd(frame, pos, tol) {
  const { p1, p2 } = frame.line;
  const reach = Math.min(tol, Math.max(6, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3));
  const d1 = Math.hypot(pos.x - p1.x, pos.y - p1.y), d2 = Math.hypot(pos.x - p2.x, pos.y - p2.y);
  if (Math.min(d1, d2) > reach) return 0;
  return d1 <= d2 ? 1 : 2;
}

function roundTransform(t) {
  return [Math.round(t[0] * 1e6) / 1e6, Math.round(t[1] * 1e6) / 1e6, Math.round(t[2] * 10) / 10, Math.round(t[3] * 10) / 10];
}

/**
 * Gemeinsame Abbildung beim Ziehen an einem Griff: die gegenüberliegende Seite des (Gruppen-)Rahmens bleibt
 * fest. Kein Spiegeln — beim Überziehen bleibt die Mindestgröße stehen.
 */
function resizeTransform(drag, dx, dy) {
  const b = drag.b0;
  let sx = 1, sy = 1, tx = 0, ty = 0;
  const minSize = 8 / state.viewScale;
  const h = drag.handle;
  const w0 = b.maxX - b.minX, h0 = b.maxY - b.minY;
  // Ohne Ausdehnung in einer Richtung (waagrechte Linie) gibt es dort nichts zu skalieren
  if (w0 > 0.05 && (h.includes('e') || h.includes('w'))) {
    const east = h.includes('e');
    const anchor = east ? b.minX : b.maxX;
    sx = Math.max(Math.min(minSize, w0), east ? w0 + dx : w0 - dx) / w0;
    tx = anchor * (1 - sx);
  }
  if (h0 > 0.05 && (h.includes('n') || h.includes('s'))) {
    const south = h.includes('s');
    const anchor = south ? b.minY : b.maxY;
    sy = Math.max(Math.min(minSize, h0), south ? h0 + dy : h0 - dy) / h0;
    ty = anchor * (1 - sy);
  }
  return [sx, sy, tx, ty];
}

/**
 * Neue Geometrie beim Ziehen an einem Endpunkt: der andere Endpunkt bleibt fest; Umschalt rastet auf
 * 45°-Schritte. Unter der Mindestlänge: null (der letzte gültige Zustand bleibt stehen).
 */
function endpointShape(drag, world, constrain) {
  const s = drag.shape0;
  const first = drag.end === 1;
  const fixed = first ? { x: s.x2, y: s.y2 } : { x: s.x1, y: s.y1 };
  const start = first ? { x: s.x1, y: s.y1 } : { x: s.x2, y: s.y2 };
  // Der Griff folgt dem Zeiger um den Weg seit dem Anfassen (kein Sprung, wenn daneben angefasst wurde)
  let x = start.x + world.x - drag.startWorld.x, y = start.y + world.y - drag.startWorld.y;
  if (constrain) {
    const ang = Math.round(Math.atan2(y - fixed.y, x - fixed.x) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(x - fixed.x, y - fixed.y);
    x = fixed.x + len * Math.cos(ang);
    y = fixed.y + len * Math.sin(ang);
  }
  const shape = roundShape(first ? { type: s.type, x1: x, y1: y, x2: fixed.x, y2: fixed.y } : { type: s.type, x1: fixed.x, y1: fixed.y, x2: x, y2: y });
  if (Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) * state.viewScale < LINE_MIN_PX) return null;
  return shape;
}

function scheduleSelRedraw() {
  if (_selRedrawQueued) return;
  _selRedrawQueued = true;
  requestAnimationFrame(() => {
    _selRedrawQueued = false;
    const t = performance.now();
    redrawStrokes();
    if (_selDrag) { _selDrag.frameMs += performance.now() - t; _selDrag.frames++; }
  });
}

/** Zieh-Geste vorbereiten: Abbildungen und Grenzen der gewählten Objekte beim Start festhalten. */
function beginSelDrag(drag) {
  const info = selectionInfo();
  if (!info) return false;
  drag.t0 = new Map(info.items.map(it => [it.id, [...it.transform]]));
  let b0 = null;
  for (const it of info.items) {
    const b = strokeGeomBounds(it.stroke);
    if (!b) continue;
    b0 = b0 ? { minX: Math.min(b0.minX, b.minX), minY: Math.min(b0.minY, b.minY), maxX: Math.max(b0.maxX, b.maxX), maxY: Math.max(b0.maxY, b.maxY) } : { ...b };
  }
  if (!b0) return false;
  drag.b0 = b0;
  if (drag.mode === 'endpoint') {
    if (info.items.length !== 1 || !isLineShape(info.items[0].stroke)) return false;
    drag.strokeId = info.items[0].id;
    drag.shape0 = { ...info.items[0].stroke.shape };
  }
  return true;
}

function selectPointerDown(e, pos, world) {
  if (_selDrag) return;
  flushNudge();
  const touch = e.pointerType === 'touch';
  // Umschalt bzw. Strg/Cmd oder der Umschalter „Mehrere“: hinzufügen/herausnehmen statt ersetzen
  const additive = e.shiftKey || e.ctrlKey || e.metaKey || _selMulti;
  const frame = selectionFrame();
  const tol = (touch ? 20 : 8) / state.viewScale;
  let mode = null, handle = null, end = 0, fresh = false, toggleId = null;
  if (frame) {
    // Griffe: bei Touch mindestens 44 px Trefferfläche
    if (frame.line) {
      end = hitLineEnd(frame, pos, touch ? 22 : 10);
      if (end) mode = 'endpoint';
    } else {
      handle = hitSelectionHandle(frame, pos, touch ? 22 : 10);
      if (handle) mode = 'resize';
    }
  }
  if (!mode) {
    // Linie/Pfeil hat keinen Rahmen: dort verschiebt nur das Ziehen an der Linie selbst
    const inFrame = !!frame && !frame.line && pos.x >= frame.x0 && pos.x <= frame.x1 && pos.y >= frame.y0 && pos.y <= frame.y1;
    const hit = additive || !inFrame ? hitTestObjects(world, tol) : null;
    if (additive) {
      // Tipp schaltet das Objekt um; Ziehen nimmt es dazu und verschiebt die Auswahl
      if (hit) { mode = 'pending'; toggleId = hit.id; }
      else mode = inFrame ? 'pending' : 'marquee-pending';
    } else if (inFrame) {
      mode = 'pending';
    } else if (hit) {
      if (!_selection?.ids.includes(hit.id)) { selectStroke(hit.id); fresh = true; }
      mode = 'pending';
    } else {
      // Leere Fläche: Auswahlrechteck aufziehen (ein Tipp ohne Ziehen hebt die Auswahl auf)
      mode = 'marquee-pending';
    }
  }
  const drag = {
    pointerId: e.pointerId, mode, handle, end, fresh, toggleId, additive, tol, moved: false,
    startPos: pos, startWorld: world, slop: touch ? 8 : 4,
    t0: null, b0: null, moveMs: 0, moves: 0, frameMs: 0, frames: 0
  };
  if ((mode === 'resize' || mode === 'endpoint') && !beginSelDrag(drag)) return;
  _selDrag = drag;
  if (mode === 'resize' || mode === 'endpoint') updateSelbar();
}

function selectPointerMove(e) {
  const drag = _selDrag;
  const pos = getCanvasPos(e);
  if (drag.mode === 'pending' || drag.mode === 'marquee-pending') {
    if (Math.hypot(pos.x - drag.startPos.x, pos.y - drag.startPos.y) < drag.slop) return;
    if (drag.mode === 'marquee-pending') {
      drag.mode = 'marquee';
    } else {
      if (drag.toggleId && !_selection?.ids.includes(drag.toggleId)) {
        const multi = _selMulti;
        selectStrokes([...(_selection?.pageKey === pageKey() ? _selection.ids : []), drag.toggleId]);
        if (multi) setSelMulti(true);
      }
      drag.toggleId = null;
      drag.mode = 'move';
      if (!beginSelDrag(drag)) { _selDrag = null; return; }
    }
  }
  if (drag.mode === 'marquee') {
    drag.moved = true;
    _marquee = { x0: drag.startPos.x, y0: drag.startPos.y, x1: pos.x, y1: pos.y };
    drawSelectionOverlay();
    return;
  }
  const t = performance.now();
  const world = screenToWorld(pos.x, pos.y);
  const dx = world.x - drag.startWorld.x, dy = world.y - drag.startWorld.y;
  if (drag.mode === 'endpoint') {
    const shape = endpointShape(drag, world, e.shiftKey);
    // Zu kurz: der letzte gültige Zustand bleibt
    if (shape) _selPreview = { strokeId: drag.strokeId, shape };
  } else {
    _selPreview = { g: drag.mode === 'move' ? [1, 1, dx, dy] : resizeTransform(drag, dx, dy), t0: drag.t0 };
  }
  drag.moved = true;
  scheduleSelRedraw();
  drag.moveMs += performance.now() - t;
  drag.moves++;
}

function selectPointerUp() {
  const drag = _selDrag;
  _selDrag = null;
  if (drag.mode === 'marquee' || drag.mode === 'marquee-pending') {
    const m = _marquee;
    _marquee = null;
    if (drag.mode === 'marquee' && m) {
      const a = screenToWorld(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1));
      const b = screenToWorld(Math.max(m.x0, m.x1), Math.max(m.y0, m.y1));
      let ids = objectsInRect({ minX: a.x, minY: a.y, maxX: b.x, maxY: b.y });
      if (drag.additive && _selection?.pageKey === pageKey()) ids = [..._selection.ids, ...ids];
      if (ids.length || !drag.additive) {
        const multi = _selMulti;
        selectStrokes(ids);
        if (multi && _selection) setSelMulti(true);
      }
    } else if (!drag.additive) {
      dropSelection();
    }
    drawSelectionOverlay();
    return;
  }
  const info = selectionInfo();
  const pv = _selPreview;
  if (drag.moved && pv && info) {
    // EINE Aktion für die ganze Geste: ein edit je Objekt, bei mehreren mit gemeinsamer groupId
    _selPreview = null;
    const t = performance.now();
    let edits;
    if (pv.shape) {
      // Die neue Geometrie enthält ein früheres Verschieben/Skalieren schon — transform zurücksetzen
      edits = info.items.some(it => it.id === pv.strokeId) ? [{ strokeId: pv.strokeId, patch: { shape: pv.shape, transform: [...IDENTITY_TRANSFORM] } }] : [];
    } else {
      edits = info.items.filter(it => drag.t0.has(it.id)).map(it => ({ strokeId: it.id, patch: { transform: roundTransform(composeTransform(pv.g, drag.t0.get(it.id))) } }));
    }
    const saved = commitEdits(info.notebookId, info.page, edits);
    const upMs = performance.now() - t;
    const base = `${edits.length} objekt${edits.length === 1 ? '' : 'e'}, zug ${(drag.moveMs / Math.max(1, drag.moves)).toFixed(2)} ms (n=${drag.moves}), bild ${(drag.frameMs / Math.max(1, drag.frames)).toFixed(1)} ms (n=${drag.frames}), loslassen ${upMs.toFixed(1)} ms`;
    _selTimingInfo = base;
    updateSyncDebug();
    saved?.then(() => { if (_selTimingInfo === base) { _selTimingInfo = `${base}, gespeichert ${(performance.now() - t).toFixed(0)} ms`; updateSyncDebug(); } });
    if (!edits.length) redrawStrokes();
    return;
  }
  const hadPreview = !!_selPreview;
  _selPreview = null;
  if (drag.mode === 'pending') {
    if (drag.toggleId) { toggleSelected(drag.toggleId); return; }
    if (!drag.fresh && !drag.additive) {
      // Tipp in den Rahmen: das Objekt darunter (allein) wählen, ins Leere hebt die Auswahl auf
      const hit = hitTestObjects(drag.startWorld, drag.tol);
      if (!hit) { dropSelection(); return; }
      if (_selection?.ids.length !== 1 || _selection.ids[0] !== hit.id) { selectStroke(hit.id); return; }
    }
  }
  if (hadPreview) redrawStrokes(); else drawSelectionOverlay();
}

/**
 * Objekte ändern: hängt je Objekt EIN edit-Event an (die Ursprungs-Events bleiben unverändert). Mehrere
 * edits sind eine Gruppe (gemeinsame groupId = ein Rückgängig-Schritt); gespeichert wird einmal, gesendet
 * gebündelt.
 * @param {Array<{strokeId: string, patch: Object}>} edits - patch: nur geänderte Felder
 *   (transform, shape, color, fill, size)
 * @returns {Promise<void>|null} läuft, bis gespeichert ist
 */
function commitEdits(notebookId, page, edits) {
  if (!page || isPageDeleted(page) || !edits.length) return null;
  if (_pendingPageOp) commitPendingPageOp();
  const group = edits.length > 1 ? { groupId: newId() } : {};
  const events = edits.map(ed => newPageEvent('edit', { targetStrokeId: ed.strokeId, patch: ed.patch, ...group }));
  applyPageEvents(page, events);
  // Eine neue eigene Aktion verwirft den Redo-Stapel dieser Seite
  clearRedoStack(notebookId, page.id);
  if (notebookId === state.currentNotebookId && page === currentPage()) redrawStrokes();
  const saved = persistPage(notebookId, page).catch(e => console.warn('[App] Änderung konnte nicht gespeichert werden:', e));
  sendPageEvents(notebookId, page.id, events);
  return saved;
}

/** Ein Objekt ändern (ein edit-Event). */
function commitEdit(notebookId, page, strokeId, patch) {
  return commitEdits(notebookId, page, [{ strokeId, patch }]);
}

/** Pfeiltasten: Auswahl schieben. Schritte kurz hintereinander werden zu EINER Aktion zusammengefasst. */
function nudgeSelection(dxPx, dyPx) {
  const info = selectionInfo();
  if (!info || _selDrag) return;
  const key = info.items.map(it => it.id).join('|');
  if (!_nudge || _nudge.key !== key || _nudge.page !== info.page) {
    flushNudge();
    _nudge = { notebookId: info.notebookId, page: info.page, key, t0: new Map(info.items.map(it => [it.id, [...it.transform]])), g: [1, 1, 0, 0], timer: null };
  }
  _nudge.g[2] += dxPx / state.viewScale;
  _nudge.g[3] += dyPx / state.viewScale;
  _selPreview = { g: [..._nudge.g], t0: _nudge.t0 };
  redrawStrokes();
  clearTimeout(_nudge.timer);
  _nudge.timer = setTimeout(flushNudge, 600);
}

/** Gesammelte Pfeiltasten-Schritte festschreiben (ein edit je Objekt, zusammen eine Aktion). */
function flushNudge() {
  const n = _nudge;
  if (!n) return;
  _nudge = null;
  clearTimeout(n.timer);
  if (_selPreview?.t0 === n.t0) _selPreview = null;
  // Inzwischen (auch anderswo) verschwundene Objekte bekommen kein edit mehr
  const there = pageDetail(n.page).byId;
  commitEdits(n.notebookId, n.page, [...n.t0].filter(([id]) => there.has(id))
    .map(([id, t]) => ({ strokeId: id, patch: { transform: roundTransform(composeTransform(n.g, t)) } })));
}

/** Linien- bzw. Flächenfarbe aller gewählten Objekte setzen. */
function setSelectedColor(color) {
  flushNudge();
  const info = selectionInfo();
  if (!info) return;
  const want = String(color).toLowerCase();
  commitEdits(info.notebookId, info.page, info.items.filter(it => String(it.stroke.color).toLowerCase() !== want)
    .map(it => ({ strokeId: it.id, patch: { color } })));
}

/** @param {string|null} fill - Füllfarbe oder null für „keine“; wirkt nur auf Rechtecke/Ellipsen der Auswahl */
function setSelectedFill(fill) {
  flushNudge();
  const info = selectionInfo();
  if (!info) return;
  commitEdits(info.notebookId, info.page, info.items.filter(it => isFillableShape(it.stroke) && (it.stroke.fill || null) !== fill)
    .map(it => ({ strokeId: it.id, patch: { fill } })));
}

/**
 * Kopien der gewählten Objekte als neue stroke-Events, leicht versetzt; die Kopien sind danach gewählt.
 * Mehrere Kopien tragen eine gemeinsame groupId (ein Rückgängig-Schritt) und werden gebündelt gesendet.
 */
function duplicateSelected() {
  flushNudge();
  const info = selectionInfo();
  if (!info) return;
  if (_pendingPageOp) commitPendingPageOp();
  const off = Math.round(160 / state.viewScale) / 10;
  const group = info.items.length > 1 ? { groupId: newId() } : {};
  const now = Date.now();
  // createdAt steigt je Kopie um 1 ms: so bleibt die Stapelfolge der Vorlagen auf allen Geräten erhalten
  const events = info.items.map((it, i) => {
    const stroke = { ...transformStroke(it.stroke, [1, 1, off, off]), id: newId(), createdAt: now + i };
    return { ...newPageEvent('stroke', { stroke, ...group }), createdAt: now + i };
  });
  const multi = _selMulti;
  applyPageEvents(info.page, events);
  clearRedoStack(info.notebookId, info.page.id);
  _selection = { pageKey: pageKey(), ids: events.map(ev => ev.stroke.id) };
  redrawStrokes();
  if (multi) setSelMulti(true);
  saveCurrentPage();
  sendPageEvents(info.notebookId, info.page.id, events);
}

/**
 * Löschen über die Auswahl = undo-Event auf jedes Objekt, gekennzeichnet mit reason:'delete'.
 * Die Kennzeichnung macht es zu einer Aktion, die Rückgängig wieder aufhebt; mehrere tragen eine groupId.
 */
function deleteSelected() {
  flushNudge();
  const info = selectionInfo();
  if (!info) return;
  if (_pendingPageOp) commitPendingPageOp();
  const { notebookId, page } = info;
  const group = info.items.length > 1 ? { groupId: newId() } : {};
  const events = info.items.map(it => newPageEvent('undo', { targetStrokeId: it.id, reason: 'delete', ...group }));
  applyPageEvents(page, events);
  clearRedoStack(notebookId, page.id);
  redrawStrokes(); // nimmt die Auswahl mit
  persistPage(notebookId, page).catch(e => console.warn('[App] Löschen konnte nicht gespeichert werden:', e));
  sendPageEvents(notebookId, page.id, events);
  showToast(events.length > 1 ? `${events.length} Objekte gelöscht` : 'Objekt gelöscht', {
    key: 'object-delete',
    action: { label: 'Rückgängig', onClick: () => restoreDeletedObjects(notebookId, page, events.map(ev => ev.id)) }
  });
}

/**
 * Ein Löschen über die Auswahl aufheben (Hinweis „Rückgängig“) — bei mehreren Objekten alle auf einmal.
 * Schon aufgehobene Lösch-Events bleiben unberührt.
 */
function restoreDeletedObjects(notebookId, page, deleteEventIds) {
  if (isPageDeleted(page)) return;
  const redone = new Set((page.events || []).filter(e => e.type === 'redo' && e.targetEventId).map(e => e.targetEventId));
  const open = deleteEventIds.filter(id => !redone.has(id));
  if (!open.length) return;
  const group = open.length > 1 ? { groupId: newId() } : {};
  const events = open.map(id => newPageEvent('redo', { targetEventId: id, ...group }));
  applyPageEvents(page, events);
  if (notebookId === state.currentNotebookId && page === currentPage()) redrawStrokes();
  persistPage(notebookId, page).catch(() => {});
  sendPageEvents(notebookId, page.id, events);
}

// ─── Tool Selection ─────────────────────────────────────────────────────────

/**
 * @param {string} tool - 'pen' | 'eraser' | 'fill' | 'shape' | 'select' | 'hand'
 * Ein Zeichenwerkzeug zu wählen schaltet die Hand aus und wird als „zuletzt benutzt“ gemerkt.
 */
function setTool(tool) {
  // Die Auswahl gehört zum Werkzeug „Auswahl“; die Hand (bewegen/zoomen) lässt sie stehen
  if (tool !== 'select' && tool !== 'hand') dropSelection();
  state.tool = tool;
  if (tool !== 'hand') state.lastDrawTool = tool;
  renderUI();
}

/** Hand-Schalter: an = bewegen/zoomen, aus = zurück zum zuletzt benutzten Werkzeug. */
function toggleHand() {
  setTool(state.tool === 'hand' ? state.lastDrawTool : 'hand');
}

/**
 * @param {string} color
 */
function setColor(color) {
  state.color = color;
  saveLocalSettings();
  renderUI();
}

/**
 * Custom-Farbe zur Palette hinzufügen (max 10).
 * @param {string} hex
 */
function addCustomColor(hex) {
  hex = hex.toLowerCase();
  if (COLORS.includes(hex) || state.customColors.includes(hex)) return;
  state.customColors.push(hex);
  if (state.customColors.length > 10) state.customColors.shift();
  saveLocalSettings();
  renderUI();
}

/** iro.js Color-Picker im Farb-Popover öffnen/schließen (freie Farbwahl). */
function toggleColorPicker(force) {
  const popup = document.getElementById('color-picker-popup');
  if (!popup) return;
  const isOpen = !popup.classList.contains('hidden');
  const open = typeof force === 'boolean' ? force : !isOpen;
  if (open === isOpen) return;
  popup.classList.toggle('hidden', !open);
  document.getElementById('btn-color-picker')?.setAttribute('aria-pressed', String(open));
  if (!open) return;
  const container = document.getElementById('iro-container');
  if (!container) return;
  container.innerHTML = '';
  // iro.js ist global via <script> geladen
  if (typeof iro === 'undefined') return;
  let picked = state.color;
  const picker = new iro.ColorPicker(container, {
    width: 180,
    color: state.color,
    borderWidth: 1,
    borderColor: '#7d8797',
    layout: [
      { component: iro.ui.Wheel },
      { component: iro.ui.Slider, options: { sliderType: 'value' } }
    ]
  });
  picker.on('color:change', (c) => { picked = c.hexString; });
  // Confirm-Button (onclick statt addEventListener: sonst sammeln sich Listener an)
  const confirmBtn = document.getElementById('iro-confirm');
  if (confirmBtn) confirmBtn.onclick = () => {
    toggleColorPicker(false);
    addCustomColor(picked);
    setColor(picked.toLowerCase());
  };
}

/**
 * @param {number} idx
 */
function setPenSize(idx) {
  state.penSizeIndex = idx;
  saveLocalSettings();
  renderUI();
}

// ─── Stiftmodus (Finger-Zeichnen blockieren) ────────────────────────────────

/** „Nur der Stift zeichnet“ setzen (Schalter in den Einstellungen). */
function setPenOnlyMode(on) {
  state.penOnlyMode = !!on;
  const sw = document.getElementById('set-pen-only');
  if (sw) sw.checked = state.penOnlyMode;
  saveLocalSettings();
}

// ─── Zen Mode ───────────────────────────────────────────────────────────────

/** Zen-Modus: Sidebar + Toolbar + Pagebar ausblenden, Fullscreen. */
function toggleZenMode() {
  state.zenMode = !state.zenMode;
  document.body.classList.toggle('zen-mode', state.zenMode);
  if (state.zenMode) {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  } else {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }
  renderUI();
  setTimeout(() => setupCanvases(), 100);
}

// ─── Popover (Farbe, Stärke, Seiten-Menü) ───────────────────────────────────

/** Alle offenen Popover schließen (auch das „⋯“-Menü eines Notizbuchs). */
function closePopovers() {
  document.querySelectorAll('[data-pop]:not([hidden])').forEach(el => {
    el.hidden = true;
    document.querySelectorAll(`[data-toggle="${el.id}"]`).forEach(b => b.setAttribute('aria-expanded', 'false'));
  });
  document.querySelectorAll('.nb-more[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  toggleColorPicker(false);
}

/** Popover eines Auslösers (data-toggle="id") umschalten; andere schließen. */
function togglePopover(trigger) {
  const el = document.getElementById(trigger.dataset.toggle);
  if (!el) return;
  const wasOpen = !el.hidden;
  closePopovers();
  if (!wasOpen) {
    el.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }
}

// ─── Dialoge (Öffnen/Schließen, Fokus, Esc, Reiter) ─────────────────────────

let _dialogSeq = 0;

/** @returns {boolean} Element ist im Bild und fokussierbar */
function isShown(el) {
  return !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/** Fokus dorthin zurückgeben, wo er vor dem Dialog war — oder zum nächstliegenden sichtbaren Auslöser. */
function restoreFocus(el) {
  if (isShown(el)) { el.focus(); return; }
  const pop = el?.closest?.('[data-pop]');
  const trigger = pop?.id === 'nb-menu' ? _nbMenuTrigger : (pop ? document.querySelector(`[data-toggle="${pop.id}"]`) : null);
  if (isShown(trigger)) { trigger.focus(); return; }
  if (document.querySelector('.sidebar.sidebar-open')) {
    (document.querySelector('#notebook-list .nb.current .nb-select') || document.getElementById('btn-close-sidebar'))?.focus();
  } else if (!el || !el.isConnected || el.closest('.sidebar, #nb-menu')) {
    document.getElementById('btn-notebooks')?.focus();
  }
}

/** Oberster offener Dialog (zuletzt geöffnet) oder null. */
function topDialog() {
  let top = null;
  document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(o => {
    if (!top || (o._seq || 0) >= (top._seq || 0)) top = o;
  });
  return top;
}

/**
 * Dialog öffnen. Der Fokus landet im Dialog und kehrt beim Schließen zurück.
 * @param {string} id - ID der .modal-overlay
 * @param {{focus?: string, onClose?: Function, returnFocus?: Element}} [opts]
 */
function openDialog(id, opts = {}) {
  const overlay = document.getElementById(id);
  if (!overlay) return null;
  const returnFocus = opts.returnFocus || document.activeElement;
  closePopovers();
  if (overlay.classList.contains('hidden') || !overlay._returnFocus) overlay._returnFocus = returnFocus;
  overlay._seq = ++_dialogSeq;
  overlay._onClose = opts.onClose || null;
  overlay.classList.remove('hidden');
  const dlg = overlay.querySelector('[role="dialog"]');
  if (dlg) dlg.scrollTop = 0;
  const target = (opts.focus && overlay.querySelector(opts.focus)) || dlg;
  target?.focus({ preventScroll: true });
  return overlay;
}

/** Dialog schließen, Aufräum-Funktion ausführen, Fokus zurückgeben. */
function closeDialog(id) {
  const overlay = document.getElementById(id);
  if (!overlay || overlay.classList.contains('hidden')) return;
  overlay.classList.add('hidden');
  const onClose = overlay._onClose;
  const back = overlay._returnFocus;
  overlay._onClose = null;
  overlay._returnFocus = null;
  try { onClose?.(); } catch (e) { console.warn('[UI] Dialog-Aufräumen:', e); }
  if (!topDialog()) restoreFocus(back);
}

/** Einmalig: Tab bleibt im obersten Dialog, Tipp neben den Dialog schließt ihn. */
function setupDialogs() {
  const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const top = topDialog();
    if (!top) return;
    const items = [...top.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && el.tabIndex >= 0 && isShown(el));
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (!top.contains(active) || active === top.querySelector('[role="dialog"]')) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault(); first.focus();
    }
  }, true);

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    let downOnBackdrop = false;
    overlay.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === overlay; });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && downOnBackdrop && !overlay.hasAttribute('data-persistent')) closeDialog(overlay.id);
      downOnBackdrop = false;
    });
  });
}

/**
 * Rückfrage als Dialog — nur vor Unwiderruflichem.
 * @param {{title: string, text: string, okLabel?: string}} opts
 * @returns {Promise<boolean>}
 */
function confirmDialog({ title, text, okLabel = 'Löschen' }) {
  return new Promise(resolve => {
    let result = false;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text;
    const okBtn = document.getElementById('confirm-ok');
    okBtn.textContent = okLabel;
    okBtn.onclick = () => { result = true; closeDialog('confirm-modal'); };
    document.getElementById('confirm-cancel').onclick = () => closeDialog('confirm-modal');
    openDialog('confirm-modal', { focus: '#confirm-cancel', onClose: () => resolve(result) });
  });
}

/**
 * Eingabe als Dialog (z. B. Passphrase). „prüfen“ darf eine Fehlermeldung liefern —
 * dann bleibt der Dialog offen und zeigt sie am Feld.
 * @param {{title: string, text?: string, label: string, type?: string, okLabel?: string,
 *          pruefen?: (wert: string) => (string|void|Promise<string|void>)}} opts
 * @returns {Promise<string|null>} Eingabe oder null bei Abbruch
 */
function promptDialog({ title, text = '', label, type = 'text', okLabel = 'OK', pruefen = null }) {
  return new Promise(resolve => {
    let result = null;
    const form = document.getElementById('prompt-form');
    const input = document.getElementById('prompt-input');
    const err = document.getElementById('prompt-error');
    const okBtn = document.getElementById('prompt-ok');
    const setError = (msg) => {
      err.textContent = msg || '';
      input.classList.toggle('error', !!msg);
      input.setAttribute('aria-invalid', String(!!msg));
    };
    document.getElementById('prompt-title').textContent = title;
    const textEl = document.getElementById('prompt-text');
    textEl.textContent = text;
    textEl.hidden = !text;
    document.getElementById('prompt-label').textContent = label;
    input.type = type;
    input.value = '';
    input.autocomplete = type === 'password' ? 'current-password' : 'off';
    okBtn.textContent = okLabel;
    setError('');
    input.oninput = () => setError('');
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (okBtn.disabled) return;
      const value = input.value;
      if (!value.trim()) { setError('Bitte etwas eingeben.'); input.focus(); return; }
      okBtn.disabled = true;
      let problem = '';
      try { problem = (await pruefen?.(value)) || ''; } catch (e2) { problem = e2?.message || 'Das hat nicht geklappt.'; }
      okBtn.disabled = false;
      if (problem) { setError(problem); input.focus(); input.select(); return; }
      result = value;
      closeDialog('prompt-modal');
    };
    document.getElementById('prompt-cancel').onclick = () => closeDialog('prompt-modal');
    openDialog('prompt-modal', { focus: '#prompt-input', onClose: () => { input.value = ''; resolve(result); } });
  });
}

/** Reiter wählen: [role=tab][data-tab] ↔ [role=tabpanel][data-panel] innerhalb von root. */
function selectTab(root, name, focusTab = false) {
  if (!root) return;
  root.querySelectorAll('[role="tab"]').forEach(tab => {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focusTab) tab.focus();
  });
  root.querySelectorAll('[role="tabpanel"]').forEach(panel => { panel.hidden = panel.dataset.panel !== name; });
}

/** Reiter bedienbar machen: Klick und Pfeiltasten. onChange(name) nach jedem Wechsel. */
function setupTabs(root, onChange) {
  if (!root) return;
  const tabs = () => [...root.querySelectorAll('[role="tab"]')];
  const go = (name, focusTab) => { selectTab(root, name, focusTab); onChange?.(name); };
  root.querySelector('[role="tablist"]')?.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) go(tab.dataset.tab, false);
  });
  root.querySelector('[role="tablist"]')?.addEventListener('keydown', (e) => {
    const list = tabs();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    if (j < 0) return;
    e.preventDefault();
    go(list[j].dataset.tab, true);
  });
}

/** Knopf-Beschriftung kurz ersetzen („Kopiert!“), danach zurück. */
function flashLabel(btn, text) {
  if (!btn) return;
  const el = btn.querySelector('[data-label]') || btn;
  if (el.dataset.orig === undefined) el.dataset.orig = el.textContent;
  el.textContent = text;
  clearTimeout(el._flashTimer);
  el._flashTimer = setTimeout(() => { el.textContent = el.dataset.orig; }, 2000);
}

/** Text in die Zwischenablage legen; Rückmeldung am Knopf und als Hinweis („Link kopiert“). */
async function copyText(text, btn, what = 'Link') {
  try {
    await navigator.clipboard.writeText(text);
    flashLabel(btn, 'Kopiert!');
    showToast(`${what} kopiert`, { key: 'copy' });
  } catch {
    flashLabel(btn, 'Nicht möglich');
    showToast('Kopieren nicht möglich', { key: 'copy', fehler: true });
  }
}

/** Symbol aus dem SVG-Sprite als Element. */
function svgIcon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}

// ─── Hinweise (Toasts) ──────────────────────────────────────────────────────

const TOAST_MAX = 3;

/**
 * Kurzen Hinweis unten einblenden — für Erfolgs- und Fehlermeldungen.
 * Mehrere Hinweise stapeln sich (höchstens 3, der älteste weicht); ein Hinweis mit
 * gleichem „key“ ersetzt seinen Vorgänger. Verschwindet von selbst; solange Maus oder
 * Tastaturfokus darauf liegen, bleibt er stehen. Esc im Hinweis schließt ihn.
 * @param {string} text
 * @param {{action?: {label: string, onClick: Function}, dauer?: number, key?: string,
 *          fehler?: boolean, onExpire?: Function}} [opts]
 *   dauer in ms (Standard 2500, mit Aktion 6000, Fehler 5000);
 *   onExpire läuft, wenn der Hinweis ohne die Aktion verschwindet.
 * @returns {{dismiss: Function}}
 */
function showToast(text, opts = {}) {
  const host = document.getElementById('toasts');
  if (!host) return { dismiss() {} };
  const { action = null, key = null, fehler = false, onExpire = null } = opts;
  const dauer = opts.dauer ?? (action ? 6000 : (fehler ? 5000 : 2500));
  if (key) [...host.children].forEach(t => { if (t.dataset.key === key) t._close?.('replaced'); });
  while (host.childElementCount >= TOAST_MAX) {
    const oldest = host.firstElementChild;
    if (oldest._close) oldest._close('replaced'); else oldest.remove();
  }

  const el = document.createElement('div');
  el.className = 'toast' + (fehler ? ' error' : '');
  if (key) el.dataset.key = key;
  const label = document.createElement('span');
  label.textContent = String(text ?? '');
  el.appendChild(label);

  let timer = null, remaining = dauer, startedAt = 0, closed = false, returnFocus = null;
  const run = () => {
    if (closed || timer || !(remaining > 0)) return;
    startedAt = Date.now();
    timer = setTimeout(() => close('expired'), remaining);
  };
  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    remaining = Math.max(1500, remaining - (Date.now() - startedAt));
  };
  const close = (reason) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    const hadFocus = el.contains(document.activeElement);
    el.remove();
    if (hadFocus && !topDialog()) restoreFocus(returnFocus);
    try {
      if (reason === 'action') action?.onClick?.();
      else onExpire?.(reason);
    } catch (e) { console.warn('[UI] Hinweis:', e); }
  };
  el._close = close;

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = action.label;
    btn.addEventListener('click', () => close('action'));
    el.appendChild(btn);
  }
  el.addEventListener('mouseenter', pause);
  el.addEventListener('mouseleave', () => { if (!el.contains(document.activeElement)) run(); });
  el.addEventListener('focusin', (e) => { if (!el.contains(e.relatedTarget)) returnFocus = e.relatedTarget; pause(); });
  el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) run(); });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close('dismissed');
  });

  host.appendChild(el);
  run();
  return { dismiss: () => close('dismissed') };
}

/** Hinweis, der ein Neuladen übersteht (z. B. „Sicherung importiert“). */
function showToastAfterReload(text) {
  try { sessionStorage.setItem('notizbuch:hinweis', text); } catch {}
}

function showStoredToast() {
  try {
    const text = sessionStorage.getItem('notizbuch:hinweis');
    if (!text) return;
    sessionStorage.removeItem('notizbuch:hinweis');
    showToast(text);
  } catch {}
}

// ─── Notizbuch-Liste (Schublade): Zeilen, „⋯“-Menü, Umbenennen, Löschen ─────

let _nbMenuFor = null;
let _nbMenuTrigger = null;

/**
 * Liste der Notizbücher aufbauen. Namen kommen u. a. aus Einladungslinks —
 * sie werden nur als Text gesetzt (textContent), nie als HTML.
 * Baut nur neu auf, wenn sich etwas geändert hat; während des Umbenennens gar nicht.
 */
function renderNotebookList(force = false) {
  const list = document.getElementById('notebook-list');
  if (!list) return;
  if (!force && list.querySelector('.rename-input')) return;
  const sig = JSON.stringify(state.notebooks.map(nb =>
    [nb.id, nb.name, nb.id === state.currentNotebookId, state.sharedNotebooks.has(nb.id)]));
  if (!force && list.dataset.sig === sig && list.childElementCount === state.notebooks.length) return;
  list.dataset.sig = sig;
  const focusedNb = list.contains(document.activeElement) ? document.activeElement.closest('.nb')?.dataset.nb : null;

  list.replaceChildren(...state.notebooks.map(nb => {
    const current = nb.id === state.currentNotebookId;
    const name = String(nb.name ?? '');
    const row = document.createElement('div');
    row.className = 'nb' + (current ? ' current' : '');
    row.dataset.nb = nb.id;

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'menu-item nb-select';
    if (current) select.setAttribute('aria-current', 'true');
    const label = document.createElement('span');
    label.className = 'nb-name';
    label.textContent = name;
    select.append(svgIcon('book'), label);
    if (state.sharedNotebooks.has(nb.id)) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'geteilt';
      select.appendChild(badge);
    }

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn ghost icon nb-more';
    more.title = 'Umbenennen, Teilen, Löschen';
    more.setAttribute('aria-label', `${name}: Umbenennen, Teilen, Löschen`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.appendChild(svgIcon('more'));

    row.append(select, more);
    return row;
  }));

  if (focusedNb) {
    [...list.children].find(r => r.dataset.nb === focusedNb)?.querySelector('.nb-select')?.focus();
  }
}

/** „⋯“-Menü eines Notizbuchs am Knopf öffnen bzw. schließen. */
function toggleNbMenu(nbId, trigger) {
  const menu = document.getElementById('nb-menu');
  if (!menu) return;
  const wasOpen = !menu.hidden && _nbMenuFor === nbId;
  closePopovers();
  if (wasOpen) return;
  _nbMenuFor = nbId;
  _nbMenuTrigger = trigger;
  const delBtn = document.getElementById('nb-menu-delete');
  if (delBtn) {
    delBtn.disabled = state.notebooks.length <= 1;
    delBtn.title = delBtn.disabled ? 'Das letzte Notizbuch kann nicht gelöscht werden' : '';
  }
  menu.hidden = false;
  const r = trigger.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  let top = r.bottom + 4;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  trigger.setAttribute('aria-expanded', 'true');
  menu.querySelector('.menu-item:not(:disabled)')?.focus();
}

/** Umbenennen direkt in der Zeile (Eingabefeld). Enter/Verlassen speichert, Esc verwirft. */
function startRenameNotebook(nbId) {
  const list = document.getElementById('notebook-list');
  const row = list && [...list.children].find(r => r.dataset.nb === nbId);
  const nb = state.notebooks.find(n => n.id === nbId);
  if (!row || !nb || row.querySelector('.rename-input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = nb.name;
  input.maxLength = 80;
  input.setAttribute('aria-label', 'Name des Notizbuchs');
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = input.value;
    const hadFocus = document.activeElement === input;
    input.remove();
    if (save && value.trim() && value.trim() !== nb.name) await renameNotebook(nbId, value);
    renderNotebookList(true);
    if (hadFocus) [...list.children].find(r => r.dataset.nb === nbId)?.querySelector('.nb-more')?.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());

  [...row.children].forEach(c => { c.hidden = true; });
  row.appendChild(input);
  input.focus();
  input.select();
}

/** Notizbuch löschen — unwiderruflich, deshalb mit Rückfrage. */
async function requestDeleteNotebook(nbId) {
  const nb = state.notebooks.find(n => n.id === nbId);
  if (!nb || state.notebooks.length <= 1) return;
  const n = nb.pages.filter(p => !isPageDeleted(p)).length;
  const ok = await confirmDialog({
    title: `„${nb.name}“ löschen?`,
    text: `${n} ${n === 1 ? 'Seite wird' : 'Seiten werden'} auf allen deinen Geräten entfernt.`,
    okLabel: 'Löschen'
  });
  if (ok) await deleteNotebook(nbId);
}

// ─── MasterKey Management ───────────────────────────────────────────────────

/** @type {Uint8Array|null} Raw MasterKey bytes (32 bytes) */
let masterKeyRaw = null;

/**
 * SHA-256 Hash der ersten 16 Bytes als Hex-String.
 * @param {Uint8Array} raw
 * @returns {Promise<string>}
 */
async function computeKeyHash(raw) {
  const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return Array.from(hashBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * MasterKey in localStorage + State speichern.
 * @param {Uint8Array} raw
 * @param {string} hash
 */
function saveMasterKeyToStorage(raw, hash) {
  masterKeyRaw = raw;
  state.masterKeyHash = hash;
  localStorage.setItem('notizbuch:masterKeyHash', hash);
  localStorage.setItem('notizbuch:masterKeyRaw', JSON.stringify(Array.from(raw)));
}

/**
 * MasterKey-Hex als Text-Datei herunterladen.
 * @param {Uint8Array} raw
 */
function downloadKeyFile(raw) {
  const hex = Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('');
  const blob = new Blob([hex], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: 'notizbuch-key.txt' });
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Hex-String zu Uint8Array konvertieren.
 * @param {string} hex
 * @returns {Uint8Array}
 */
function hexToBytes(hex) {
  hex = hex.replace(/\s/g, '');
  if (hex.length !== 64) throw new Error('Key muss 64 Hex-Zeichen (32 Bytes) lang sein');
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error('Ungültiges Hex-Format');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

/**
 * Erststart, Schritt 1: Neuen Schlüssel erzeugen oder bestehenden importieren.
 * @returns {Promise<string>} masterKeyHash
 */
function showFirstStartDialog() {
  return new Promise(resolve => {
    const open = () => openDialog('firststart-modal', { focus: '#btn-new-start' });

    document.getElementById('btn-new-start').onclick = async () => {
      closeDialog('firststart-modal');
      const hash = await generateAndSaveKey();
      await showKeyDisplayDialog(masterKeyRaw);
      resolve(hash);
    };

    document.getElementById('btn-import-key').onclick = async () => {
      closeDialog('firststart-modal');
      const hash = await showKeyImportDialog();
      if (hash) resolve(hash);
      else open(); // „Zurück“
    };

    // Sicherung einspielen: Der Dialog bleibt offen, bis eine Datei gewählt ist.
    // Nach erfolgreichem Einspielen lädt die App neu — resolve() ist dann nicht nötig.
    document.getElementById('btn-restore-backup').onclick = async () => {
      const file = await chooseBackupFile();
      if (!file) return;
      closeDialog('firststart-modal');
      let done = false;
      try { done = await importBackupFile(file); } catch (e) {
        console.warn('[Import] fehlgeschlagen:', e?.name || 'Fehler');
        showToast('Import fehlgeschlagen.', { fehler: true });
      }
      if (!done && !masterKeyRaw) open();
    };

    open();
  });
}

/**
 * Neuen zufälligen MasterKey generieren und speichern.
 * @returns {Promise<string>} masterKeyHash
 */
async function generateAndSaveKey() {
  const key = await generateKey();
  const raw = new Uint8Array(await exportKey(key));
  const hash = await computeKeyHash(raw);
  saveMasterKeyToStorage(raw, hash);
  return hash;
}

/** Schlüssel als Hex-Text. */
function keyHex(raw) {
  return Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Hex-Schlüssel in Achtergruppen (besser les- und abschreibbar). */
function groupHex(hex) {
  return (hex.match(/.{1,8}/g) || []).join(' ');
}

/**
 * Erststart, Schritt 2: Schlüssel zeigen, Sichern anbieten, Bestätigung abwarten.
 * @param {Uint8Array} raw
 * @returns {Promise<void>}
 */
function showKeyDisplayDialog(raw) {
  return new Promise(resolve => {
    const hex = keyHex(raw);
    const keyEl = document.getElementById('keydisplay-key');
    if (keyEl) keyEl.textContent = groupHex(hex);

    document.getElementById('btn-download-key').onclick = () => downloadKeyFile(raw);
    document.getElementById('btn-copy-key').onclick = (e) => copyText(hex, e.currentTarget, 'Schlüssel');
    document.getElementById('btn-key-confirmed').onclick = () => {
      closeDialog('keydisplay-modal');
      if (keyEl) keyEl.textContent = '';
      resolve();
    };
    openDialog('keydisplay-modal');
  });
}

/**
 * Schlüssel-Import: Hex-Eingabe oder Datei.
 * @returns {Promise<string|null>} masterKeyHash, oder null bei „Zurück“
 */
function showKeyImportDialog() {
  return new Promise(resolve => {
    const input = document.getElementById('keyimport-input');
    const fileInput = document.getElementById('keyimport-file');
    const error = document.getElementById('keyimport-error');
    const setError = (msg) => {
      error.textContent = msg || '';
      input.classList.toggle('error', !!msg);
      input.setAttribute('aria-invalid', String(!!msg));
    };
    input.value = '';
    setError('');

    const submit = async (hex) => {
      try {
        const hash = await importKeyFromHex(hex);
        closeDialog('keyimport-modal');
        input.value = '';
        resolve(hash);
      } catch (e) {
        setError(e.message);
        input.focus();
      }
    };

    document.getElementById('keyimport-ok').onclick = () => submit(input.value);
    document.getElementById('keyimport-back').onclick = () => { closeDialog('keyimport-modal'); resolve(null); };
    document.getElementById('btn-keyimport-file').onclick = () => fileInput.click();
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(input.value); } };
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      const text = (await file.text()).trim();
      input.value = text;
      submit(text);
    };
    openDialog('keyimport-modal', { focus: '#keyimport-input' });
  });
}

/**
 * MasterKey aus Hex-String importieren und speichern.
 * @param {string} hex
 * @returns {Promise<string>} masterKeyHash
 */
async function importKeyFromHex(hex) {
  const raw = hexToBytes(hex.trim());
  const hash = await computeKeyHash(raw);
  saveMasterKeyToStorage(raw, hash);
  return hash;
}

/**
 * Gespeicherten MasterKey laden, URL-Hash prüfen, oder Dialog zeigen.
 * URL-Format: #{fullMasterKeyHex} (64 Hex-Zeichen = 32 Bytes = voller AES-256 Key)
 * Wer die URL hat, hat den Key — kein Import-Dialog nötig.
 * @returns {Promise<string>} masterKeyHash
 */
/**
 * @param {boolean} [hasInvite=false] - Invite-Link erkannt → MasterKey still generieren
 */
async function initMasterKey(hasInvite = false) {
  // 1. URL-Hash prüfen (voller MasterKey von anderem Gerät/Share)
  const hash = location.hash.slice(1);
  if (hash && !hash.startsWith('nb') && hash.length === 64 && /^[0-9a-fA-F]+$/.test(hash)) {
    // Voller Key in URL → direkt importieren, kein Dialog
    return importKeyFromHex(hash);
  }

  // 2. Gespeicherten Key prüfen
  const savedHash = localStorage.getItem('notizbuch:masterKeyHash');
  const savedRaw = localStorage.getItem('notizbuch:masterKeyRaw');
  if (savedHash && savedRaw) {
    try {
      masterKeyRaw = new Uint8Array(JSON.parse(savedRaw));
      state.masterKeyHash = savedHash;
      return savedHash;
    } catch {}
  }

  // 3. Invite-Link → MasterKey still generieren (kein Dialog)
  if (hasInvite) {
    return generateAndSaveKey();
  }

  // 4. Kein gespeicherter Key, kein URL-Hash → Erst-Start
  return showFirstStartDialog();
}

// ─── NotebookKey Management ─────────────────────────────────────────────────

/**
 * NotebookHash berechnen: SHA-256(NotebookKey) → erste 16 Bytes als Hex.
 * @param {string} notebookId
 * @returns {Promise<string>}
 */
async function notebookHash(notebookId) {
  const key = await getNotebookKey(notebookId);
  const raw = await exportKey(key);
  return computeKeyHash(raw);
}

/** Geteilte Notebooks in localStorage speichern. */
function saveSharedNotebooks() {
  localStorage.setItem('notizbuch:sharedNotebooks', JSON.stringify([...state.sharedNotebooks]));
}

/** Geteilte Notebooks aus localStorage laden. */
function loadSharedNotebooks() {
  try {
    const saved = localStorage.getItem('notizbuch:sharedNotebooks');
    if (saved) state.sharedNotebooks = new Set(JSON.parse(saved));
  } catch {}
}

/**
 * Daten aus einem geteilten Relay-Room in ein Notebook mergen.
 * @param {string} notebookId
 * @param {Object<string, Uint8Array>} nodes - Relay-Blobs
 */
async function mergeSharedNotebookData(notebookId, nodes) {
  const nb = state.notebooks.find(n => n.id === notebookId);
  if (!nb) return;
  console.log('[Share] mergeSharedNotebookData:', notebookId, Object.keys(nodes).length, 'Blobs');

  let merged = 0;
  const changedPages = new Set();
  const metaBefore = JSON.stringify(nb.pages.map(pageMeta));
  for (const [key, blob] of Object.entries(nodes)) {
    // Pages: key = "p:{pageId}"
    if (!key.startsWith('p:') || !(blob instanceof Uint8Array)) continue;
    const pageId = key.slice(2);
    let disk = { events: [] };
    try { disk = await deserializePageData(blob, notebookId); } catch (e) {
      console.warn('[Share] Page-decrypt fehlgeschlagen:', pageId, e);
      continue;
    }
    if (!(disk.events?.length)) continue;

    let page = nb.pages.find(p => p.id === pageId);
    if (!page) {
      // Neue Seite erstellen
      page = { id: pageId, strokes: [], events: [], background: 'grid', order: nb.pages.length, createdAt: 0, deletedAt: 0 };
      nb.pages.push(page);
      normalizePageOrder(nb);
    }
    // Shared relay page-blob enthält das Event-Log: Vereinigung nach Event-ID.
    if (mergePageEvents(page, disk.events || [])) {
      merged++;
      changedPages.add(pageId);
    }
  }

  // Meta aus shared Room (Notebook-Name, Page-Struktur)
  const metaBlob = nodes['meta'];
  if (metaBlob instanceof Uint8Array) {
    try {
      const nbKey = await getNotebookKey(notebookId);
      const plainBuf = await decrypt(nbKey, metaBlob);
      const sharedMeta = JSON.parse(new TextDecoder().decode(plainBuf));
      if (sharedMeta.name && nb.name === 'Geteiltes Notizbuch') nb.name = sharedMeta.name;
      // Fehlende Pages anlegen
      if (sharedMeta.pages) {
        for (const sp of sharedMeta.pages) {
          const existingPage = nb.pages.find(p => p.id === sp.id);
          if (!existingPage) {
            nb.pages.push({ ...pageMeta(sp), order: sp.order ?? nb.pages.length, strokes: [] });
            normalizePageOrder(nb);
          } else {
            applyPageMeta(existingPage, sp);
          }
        }
        normalizePageOrder(nb);
      }
    } catch (e) { console.warn('[Share] Meta-decrypt fehlgeschlagen:', e); }
  }

  // Nach Meta-Merge Seiten neu materialisieren, da sich clearedAt/deletedAt geändert haben können
  for (const page of nb.pages) {
    const before = page.strokes?.length || 0;
    refreshPageMaterializedState(page);
    if ((page.strokes?.length || 0) !== before) changedPages.add(page.id);
  }

  // Strokes lokal speichern (OPFS) damit sie persistent sind
  for (const pageId of changedPages) {
    const page = nb.pages.find(p => p.id === pageId);
    if (page) {
      const data = await serializePageData(page, notebookId);
      await savePageData(notebookId, String(pageId), data);
    }
  }

  // Auch reine Meta-Änderungen (gelöscht/wiederhergestellt, neue Seite) speichern und anzeigen
  const metaChanged = JSON.stringify(nb.pages.map(pageMeta)) !== metaBefore;
  if (merged > 0 || changedPages.size > 0 || metaChanged) {
    console.log(`[Share] ${merged} Strokes aus Relay gemerged für Notebook ${notebookId}`);
    // Aktuelle Seite neu zeichnen falls betroffen
    if (notebookId === state.currentNotebookId) {
      const curPage = currentPage();
      if (curPage && changedPages.has(curPage.id)) redrawStrokes();
    }
    await saveAppMeta();
    _lastRelayMergeAt = Date.now();
    if (metaChanged) { renderUI(); refreshPageOverview(); }
    updateSyncDebug('relay-shared-merge');
  }
}

/**
 * Alle Pages eines geteilten Notebooks an den shared Relay-Room pushen.
 * @param {string} notebookId
 */
async function pushSharedNotebook(notebookId, opts = {}) {
  const nb = state.notebooks.find(n => n.id === notebookId);
  if (!nb) { console.warn('[Share] pushSharedNotebook: notebook nicht gefunden', notebookId); return; }
  const nbHash = await notebookHash(notebookId);

  // 1. Erst Remote-Daten fetchen + mergen (verhindert Überschreiben fremder Strokes)
  try {
    const remoteNodes = await fetchRoom(nbHash);
    if (remoteNodes && Object.keys(remoteNodes).length > 0) {
      await mergeSharedNotebookData(notebookId, remoteNodes);
    }
  } catch (e) { console.warn('[Share] Pre-push fetch fehlgeschlagen:', e); }

  // 2. Aktuellen (gemergten) State serialisieren
  const blobs = [];
  try {
    const nbKey = await getNotebookKey(notebookId);
    const meta = { name: nb.name, pages: nb.pages.map(pageMeta) };
    const metaEncrypted = await encrypt(nbKey, JSON.stringify(meta));
    blobs.push({ id: 'meta', data: metaEncrypted });
  } catch (e) { console.warn('[Share] Meta-encrypt fehlgeschlagen:', e); }

  const selectedPageIds = opts.pageIds?.length ? new Set(opts.pageIds) : null;
  for (const page of nb.pages) {
    if (selectedPageIds && !selectedPageIds.has(page.id)) continue;
    // Auch leere Seiten pushen, wenn sie Events haben (z.B. alles per Undo entfernt)
    if (!(page.events?.length)) continue;
    try {
      const encrypted = await serializePageData(page, notebookId);
      blobs.push({ id: `p:${page.id}`, data: encrypted });
    } catch (e) { console.warn('[Share] Page-encrypt fehlgeschlagen:', page.id, e); }
  }

  console.log('[Share] pushSharedNotebook:', notebookId, '→ Room', nbHash.slice(0, 8), '|', blobs.length, 'Blobs');
  await pushBlobsToRoom(nbHash, blobs);
}

/** Map: notebookId → notebookHash (für P2P-Room-Lookup bei Stroke-Events). */
const _sharedRoomMap = new Map();

/** P2P-Room für ein geteiltes Notebook beitreten. */
async function joinSharedNotebookP2P(notebookId) {
  const nbHash = await notebookHash(notebookId);
  _sharedRoomMap.set(notebookId, nbHash);
  await joinSharedRoom(nbHash, _p2pCallbacks);
  openLiveChannel(nbHash, onLiveEvent);
}

/** Alle bekannten geteilten Notebooks im P2P verbinden. */
async function joinAllSharedNotebooksP2P() {
  for (const nbId of state.sharedNotebooks) {
    try { await joinSharedNotebookP2P(nbId); }
    catch (e) { console.warn('[P2P] Shared room join fehlgeschlagen:', nbId, e); }
  }
}

/** P2P-Room für notebookId verlassen. */
function leaveSharedNotebookP2P(notebookId) {
  const nbHash = _sharedRoomMap.get(notebookId);
  if (nbHash) {
    leaveSharedRoom(nbHash);
    closeLiveChannel(nbHash);
    _sharedRoomMap.delete(notebookId);
  }
}

/**
 * P2P-Action senden: an Main-Room (eigene Geräte) UND an Shared-Room falls geteilt.
 * @param {string} action
 * @param {Object} data - muss notebookId enthalten
 */
function p2pSendForNotebook(action, data) {
  syncSend(action, data, { forNotebook: true });
}

async function resyncSharedNotebook(notebookId, opts = {}) {
  const nb = state.notebooks.find(n => n.id === notebookId);
  if (!nb) return;
  try {
    updateSyncDebug(`shared-resync:${opts.reason || 'manual'}:${notebookId.slice(0,8)}`);
    await joinSharedNotebookP2P(notebookId);
  } catch (e) {
    console.warn('[P2P] Shared rejoin fehlgeschlagen:', notebookId, e);
  }
  try {
    const nbHash = await notebookHash(notebookId);
    const remoteNodes = await fetchRoom(nbHash);
    if (remoteNodes) await mergeSharedNotebookData(notebookId, remoteNodes);
  } catch (e) {
    console.warn('[Share] Shared resync fetch fehlgeschlagen:', notebookId, e);
  }

  if (opts.sendMeta !== false) {
    const metaPayload = buildNotebookMetaPayload(notebookId);
    if (metaPayload) p2pSendForNotebook('full-sync', metaPayload);
  }
}

async function resyncVisibleSharedNotebooks(reason = 'manual', opts = {}) {
  const now = Date.now();
  const minInterval = opts.minIntervalMs ?? 15000;
  if (now - _lastSharedResyncAt < minInterval) return;
  _lastSharedResyncAt = now;
  updateSyncDebug(`shared-resync-all:${reason}`);
  const notebookIds = [];
  if (state.currentNotebookId && state.sharedNotebooks.has(state.currentNotebookId)) notebookIds.push(state.currentNotebookId);
  for (const nbId of state.sharedNotebooks) {
    if (!notebookIds.includes(nbId)) notebookIds.push(nbId);
  }
  for (const nbId of notebookIds) {
    await resyncSharedNotebook(nbId, { reason, sendMeta: opts.sendMeta });
  }
}

/** Sync-Diagnose (Overlay unten rechts). Gerätelokal gemerkt; Schalter in Einstellungen → Verbindung. */
function isSyncDebugOn() {
  return localStorage.getItem('notizbuch:debugOverlay') === '1';
}

function applySyncDebugVisibility() {
  document.getElementById('console')?.classList.toggle('debug-off', !isSyncDebugOn());
}

function setSyncDebug(on) {
  localStorage.setItem('notizbuch:debugOverlay', on ? '1' : '0');
  const sw = document.getElementById('set-diag');
  if (sw) sw.checked = !!on;
  applySyncDebugVisibility();
  updateSyncDebug();
}

function updateSyncDebug(status = _syncDebugStatus) {
  _syncDebugStatus = status;
  const box = document.getElementById('console');
  if (!box) return;
  if (!isSyncDebugOn()) return;
  const since = _lastSyncActivity ? `${Math.round((Date.now() - _lastSyncActivity) / 1000)}s` : '-';
  const peers = state.connectedPeers.length ? state.connectedPeers.map(id => id.slice(0, 8)).join(', ') : 'keine';
  const shared = [...state.sharedNotebooks].map(id => id === state.currentNotebookId ? id.slice(0, 8) + ' *' : id.slice(0, 8)).join(', ') || 'keine';
  const p2pIn = _lastP2PInAt ? `${Math.round((Date.now() - _lastP2PInAt) / 1000)}s` : '-';
  const p2pOut = _lastP2POutAt ? `${Math.round((Date.now() - _lastP2POutAt) / 1000)}s` : '-';
  const relayIn = _lastRelayMergeAt ? `${Math.round((Date.now() - _lastRelayMergeAt) / 1000)}s` : '-';
  const relayLiveIn = _lastRelayLiveInAt ? `${Math.round((Date.now() - _lastRelayLiveInAt) / 1000)}s` : '-';
  const liveStatus = liveChannelStatus();
  const unsupported = liveStatus.some(s => s.state === 'nicht unterstützt');
  const mainEntry = liveStatus.find(s => s.roomKey === state.masterKeyHash);
  const sharedEntries = liveStatus.filter(s => s.roomKey !== state.masterKeyHash);
  const relayLiveText = unsupported
    ? 'nicht unterstützt (alter Server)'
    : `main ${mainEntry?.state || 'getrennt'}, shared ${sharedEntries.filter(s => s.state === 'verbunden').length}/${sharedEntries.length}`;
  const safePeerId = id => (id || '').toString().replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  const cp = currentPage();
  const strokeLine = cp ? `striche: ${cp.strokes?.length || 0} (events: ${cp.events?.length || 0})` : 'striche: 0 (events: 0)';

  const lines = [
    `v ${APP_VERSION}`,
    `status: ${status}`,
    `sichtbar: ${document.visibilityState}`,
    `ice: ${getIceStatus().replace(/[<>&]/g, '')}`,
    `peers: ${state.connectedPeers.length} [${peers}]`,
    `relay: ${isRelayConnected() ? 'verbunden' : 'weg'}${getCustomRelayUrl() ? ' (eigene Adresse)' : ''}`,
    `relay live: ${relayLiveText}`,
    `device: ${(state.deviceId || '-').slice(0, 8)}`,
    `aktuelles nb: ${(state.currentNotebookId || '-').slice(0, 8)}`,
    `host: ${((state.hostByNotebook[state.currentNotebookId] || '-')).slice(0, 8)} (${currentNotebookRole()})`,
    `shared: ${shared}`,
    `letzte aktivität: ${since}`,
    `p2p in/out: ${p2pIn} / ${p2pOut}`,
    `relay live in: ${relayLiveIn}`,
    `relay merge: ${relayIn}`,
    strokeLine,
    `ansicht: ${state.viewScale.toFixed(4)} ${state.viewX.toFixed(1)} ${state.viewY.toFixed(1)}`,
    ...(_lastFillInfo ? [`füllen: ${_lastFillInfo}`] : []),
    _selDebugLine,
    ...(_selTimingInfo ? [`auswahl-zeit: ${_selTimingInfo}`] : []),
    `letzter shared resync: ${_lastSharedResyncAt ? Math.round((Date.now() - _lastSharedResyncAt) / 1000) + 's' : '-'}`
  ];

  for (const d of _peerDiagnostics) {
    const role = d.isMain ? 'main' : 'shared';
    lines.push(`↳ ${safePeerId(d.peerId)} ${role} ${d.iceState} ${d.localType}/${d.remoteType} ${d.protocol}`);
  }

  // Als Text setzen (kein HTML): Zeilen enthalten Daten von Peers
  box.textContent = lines.join('\n');
}

function markSyncActivity(status) {
  _lastSyncActivity = Date.now();
  if (status?.startsWith('send:')) _lastP2POutAt = _lastSyncActivity;
  if (status?.startsWith('recv:relay:')) {
    _lastRelayLiveInAt = _lastSyncActivity;
  } else if (status?.startsWith('recv:')) {
    _lastP2PInAt = _lastSyncActivity;
  }
  updateSyncDebug(status);
}

/**
 * URL-Hash auf aktuelles Notebook setzen: #nb-{notebookHash}
 */
async function updateUrlHash() {
  if (!state.currentNotebookId) return;
  const hash = await notebookHash(state.currentNotebookId);
  history.replaceState(null, '', location.pathname + '#nb-' + hash);
}

/**
 * Notebook-ID anhand eines NotebookHash finden.
 * @param {string} hash
 * @returns {Promise<string|null>} notebookId oder null
 */
async function findNotebookByHash(hash) {
  for (const nb of state.notebooks) {
    const h = await notebookHash(nb.id);
    if (h === hash) return nb.id;
  }
  return null;
}

/**
 * NotebookKey für ein Notebook holen (oder erstellen + speichern).
 * @param {string} notebookId
 * @returns {Promise<CryptoKey>}
 */
async function getNotebookKey(notebookId) {
  if (state.notebookKeys[notebookId]) return state.notebookKeys[notebookId];

  // Aus localStorage laden
  const stored = localStorage.getItem(`notizbuch:nbKey:${notebookId}`);
  if (stored) {
    try {
      const raw = new Uint8Array(JSON.parse(stored));
      const key = await importKey(raw, true);
      state.notebookKeys[notebookId] = key;
      return key;
    } catch {}
  }

  // Neuen Key generieren + speichern
  const key = await generateKey(true);
  state.notebookKeys[notebookId] = key;
  const raw = await exportKey(key);
  localStorage.setItem(`notizbuch:nbKey:${notebookId}`, JSON.stringify(Array.from(raw)));
  return key;
}

/**
 * MasterKey als CryptoKey importieren (für Meta-Verschlüsselung).
 * @returns {Promise<CryptoKey|null>}
 */
async function getMasterCryptoKey() {
  if (!masterKeyRaw) return null;
  return importKey(masterKeyRaw, true);
}

// ─── Relay Sync ──────────────────────────────────────────────────────────────

/**
 * Relay-Daten entschlüsseln und in lokalen State mergen.
 * Wandelt Relay-Blobs in Full-Sync-Format um und nutzt applyFullSync().
 * @param {Object<string, Uint8Array>} nodes - Relay-Nodes (meta + page blobs)
 */
async function mergeRelayData(nodes) {
  const metaBlob = nodes['meta'];
  if (!metaBlob || !(metaBlob instanceof Uint8Array)) return;

  let relayMeta;
  try {
    const masterKey = await getMasterCryptoKey();
    if (!masterKey) return;
    const plainBuf = await decrypt(masterKey, metaBlob);
    relayMeta = JSON.parse(new TextDecoder().decode(plainBuf));
  } catch {
    console.warn('[Relay] Meta-Entschlüsselung fehlgeschlagen');
    return;
  }
  if (!relayMeta?.notebooks?.length) return;

  // NotebookKeys aus Relay-Meta installieren (bevor Page-Daten entschlüsselt werden)
  await installNotebookKeys(relayMeta.notebookKeys);

  // Relay-Daten in Full-Sync-Format umwandeln
  const payload = { notebooks: [] };
  for (const nb of relayMeta.notebooks) {
    const syncNb = { id: nb.id, name: nb.name, pages: [] };
    for (const p of nb.pages) {
      const pageBlob = nodes[`p:${nb.id}/${p.id}`];
      let events = [];
      if (pageBlob instanceof Uint8Array) {
        try { events = (await deserializePageData(pageBlob, nb.id)).events || []; } catch {}
      }
      syncNb.pages.push({ ...pageMeta(p), events });
    }
    payload.notebooks.push(syncNb);
  }

  await applyFullSync(payload);
  _lastRelayMergeAt = Date.now();
  updateSyncDebug('relay-merge');
  console.log('[Relay] Daten gemerged:', payload.notebooks.length, 'Notebooks');
}

/**
 * Alle Pages an Relay pushen (nach Init, im Hintergrund).
 */
async function pushAllToRelay() {
  if (!isRelayConnected()) return;
  const nb = currentNotebook();
  const page = currentPage();
  if (!nb || !page) return;
  try {
    const data = await serializePageData(page, nb.id);
    relayPut(`p:${nb.id}/${page.id}`, data);
  } catch {}
  if (state.sharedNotebooks.has(nb.id)) {
    await pushSharedNotebook(nb.id, { pageIds: [page.id] });
  }
  console.log('[Relay] Aktuelle Page an Relay gepusht');
}

// ─── P2P Sync Integration ───────────────────────────────────────────────────

/**
 * Kompletten App-State als Sync-Payload erstellen.
 * @returns {Object}
 */
function buildFullSyncPayload(opts = {}) {
  const notebookIds = opts.notebookIds || (state.currentNotebookId ? [state.currentNotebookId] : []);
  const includeAllPageStrokes = opts.includeAllPageStrokes ?? false;
  return {
    eventId: newEventId(),
    notebooks: notebookIds
      .map(nbId => state.notebooks.find(n => n.id === nbId))
      .filter(Boolean)
      .map(nb => notebookMeta(nb, { includePageStrokes: includeAllPageStrokes }))
  };
}

/**
 * Full-Sync Payload in lokalen State mergen (Union-Merge).
 * @param {Object} payload - { notebooks: [...] }
 */
async function applyFullSync(payload) {
  if (_dataSwapRunning) return;
  if (!payload?.notebooks?.length) return;

  for (const remoteNb of payload.notebooks) {
    const localNb = mergeNotebookMetaIntoState(remoteNb);
    for (const remotePage of (remoteNb.pages || [])) {
      const localPage = localNb.pages.find(p => p.id === remotePage.id);
      if (!localPage) continue;
      if (remotePage.events?.length) {
        mergePageEvents(localPage, remotePage.events);
      } else {
        normalizePageStrokes(localPage, remotePage.strokes || []);
      }
    }
  }

  // Sortieren und persistieren
  state.notebooks.sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
  await saveAppMeta();
  // Alle Pages speichern (auch leere — damit Clear-Zustand persistiert wird)
  for (const nb of state.notebooks) {
    for (const p of nb.pages) {
      try {
        await savePageData(nb.id, p.id, await serializePageData(p, nb.id));
      } catch (e) {
        console.warn('[Sync] Seite konnte nicht gespeichert werden:', p.id, e);
      }
    }
  }
}

/** P2P-Room beitreten und alle Callbacks verdrahten. */
/**
 * Bei Shared-Room-Events: lokale notebookId aus roomId (=notebookHash) auflösen.
 * Bei Main-Room: notebookId aus dem Event verwenden.
 */
function _resolveNbId(eventNbId, roomId) {
  if (!roomId || roomId === state.masterKeyHash) return eventNbId;
  // Shared Room → notebookId per Hash finden
  for (const [nbId, hash] of _sharedRoomMap) {
    if (hash === roomId) return nbId;
  }
  return eventNbId;
}

const _p2pCallbacks = {
  onStroke(payload, peerId, roomId) {
    if (rememberSyncEvent(payload?.eventId)) return;
    forwardSyncEvent('stroke', payload, roomId, peerId);
    let { notebookId, pageId, stroke, pageEvent } = payload;
    notebookId = _resolveNbId(notebookId, roomId);
    const nb = state.notebooks.find(n => n.id === notebookId);
    if (!nb) return;
    const page = nb.pages.find(p => p.id === pageId);
    if (!page || isPageDeleted(page)) return;
    if (pageEvent) {
      mergePageEvents(page, [pageEvent]);
    } else {
      // Abwärtskompatibilität zu alten Clients, die nur stroke senden
      normalizePageStrokes(page, [stroke]);
    }
    if (notebookId === state.currentNotebookId && pageId === currentPage()?.id) {
      redrawStrokes();
    }
    refreshPageOverview();
    if (peerId !== 'relay') markSyncActivity('recv:stroke');
    serializePageData(page, notebookId).then(d => savePageData(notebookId, pageId, d));
  },

  onUndo(payload, peerId, roomId) {
    if (rememberSyncEvent(payload?.eventId)) return;
    forwardSyncEvent('undo', payload, roomId, peerId);
    let { notebookId, pageId, strokeId, pageEvent } = payload;
    notebookId = _resolveNbId(notebookId, roomId);
    const nb = state.notebooks.find(n => n.id === notebookId);
    const page = nb?.pages.find(p => p.id === pageId);
    if (!page || isPageDeleted(page)) return;
    if (pageEvent) {
      mergePageEvents(page, [pageEvent]);
    } else if (strokeId) {
      // Abwärtskompatibilität: synthetisches Undo-Event erzeugen
      mergePageEvents(page, [{
        id: `undo:${strokeId}`,
        type: 'undo',
        targetStrokeId: strokeId,
        createdAt: Date.now(),
        deviceId: 'legacy',
        seq: 0
      }]);
    }
    if (notebookId === state.currentNotebookId && pageId === currentPage()?.id) redrawStrokes();
    refreshPageOverview();
    serializePageData(page, notebookId).then(d => savePageData(notebookId, pageId, d));
  },

  onRedo(payload, peerId, roomId) {
    if (rememberSyncEvent(payload?.eventId)) return;
    forwardSyncEvent('redo', payload, roomId, peerId);
    let { notebookId, pageId, pageEvent } = payload;
    notebookId = _resolveNbId(notebookId, roomId);
    const nb = state.notebooks.find(n => n.id === notebookId);
    const page = nb?.pages.find(p => p.id === pageId);
    if (!page || isPageDeleted(page)) return;
    if (pageEvent?.type !== 'redo' || !pageEvent.targetEventId) return;
    // Der lokale Redo-Stapel bleibt von Remote-Events unberührt
    mergePageEvents(page, [pageEvent]);
    if (notebookId === state.currentNotebookId && pageId === currentPage()?.id) redrawStrokes();
    refreshPageOverview();
    serializePageData(page, notebookId).then(d => savePageData(notebookId, pageId, d));
  },

  onEdit(payload, peerId, roomId) {
    if (rememberSyncEvent(payload?.eventId)) return;
    forwardSyncEvent('edit', payload, roomId, peerId);
    let { notebookId, pageId, pageEvent } = payload;
    notebookId = _resolveNbId(notebookId, roomId);
    const nb = state.notebooks.find(n => n.id === notebookId);
    const page = nb?.pages.find(p => p.id === pageId);
    if (!page || isPageDeleted(page)) return;
    if (pageEvent?.type !== 'edit' || !pageEvent.targetStrokeId) return;
    // Wer zuletzt geändert hat, gewinnt (materializePage) — der Auswahlrahmen folgt beim Neuzeichnen
    mergePageEvents(page, [pageEvent]);
    if (notebookId === state.currentNotebookId && pageId === currentPage()?.id) redrawStrokes();
    refreshPageOverview();
    serializePageData(page, notebookId).then(d => savePageData(notebookId, pageId, d));
  },

  /** Mehrere Seiten-Events einer Aktion (Gruppe aus der Mehrfachauswahl) in einer Nachricht. */
  onBatch(payload, peerId, roomId) {
    if (rememberSyncEvent(payload?.eventId)) return;
    forwardSyncEvent('batch', payload, roomId, peerId);
    let { notebookId, pageId, pageEvents } = payload;
    notebookId = _resolveNbId(notebookId, roomId);
    const nb = state.notebooks.find(n => n.id === notebookId);
    const page = nb?.pages.find(p => p.id === pageId);
    if (!page || isPageDeleted(page)) return;
    const events = (Array.isArray(pageEvents) ? pageEvents : []).filter(e => e && e.id && (
      (e.type === 'stroke' && e.stroke?.id)
      || (e.type === 'undo' && (e.targetStrokeId || e.targetEventId))
      || (e.type === 'redo' && e.targetEventId)
      || (e.type === 'edit' && e.targetStrokeId)));
    if (!events.length) return;
    // Der lokale Redo-Stapel bleibt von Remote-Events unberührt; gespeichert wird einmal
    mergePageEvents(page, events);
    if (notebookId === state.currentNotebookId && pageId === currentPage()?.id) redrawStrokes();
    refreshPageOverview();
    if (peerId !== 'relay') markSyncActivity('recv:batch');
    serializePageData(page, notebookId).then(d => savePageData(notebookId, pageId, d));
  },

  onClear() {},

  onPageCreated() {},

  onPageDeleted() {},

  onPageRestored() {},

  onPageBg(payload, peerId, roomId) {
    if (rememberSyncEvent(payload?.eventId)) return;
    let { notebookId, pageId, background } = payload;
    notebookId = _resolveNbId(notebookId, roomId);
    const nb = state.notebooks.find(n => n.id === notebookId);
    if (!nb) return;
    const page = nb.pages.find(p => p.id === pageId);
    if (!page || isPageDeleted(page)) return;
    page.background = background;
    saveAppMeta();
    if (notebookId === state.currentNotebookId && page.id === currentPage()?.id) {
      redrawBackground();
    }
    renderUI();
  },

  // Bei Peer-Join in Shared Room: Full-Sync des geteilten Notebooks senden
  async onPeerJoin(peerId, roomId) {
    if (!roomId || roomId === state.masterKeyHash) return; // Main-Room hat eigenen Handler
    const nbId = _resolveNbId(null, roomId);
    if (!nbId) return;
    const nb = state.notebooks.find(n => n.id === nbId);
    if (!nb) return;
    const payload = buildFullSyncPayload({ notebookIds: [nb.id] });
    syncSend('full-sync', payload, { peerId, roomId, noRelay: true });
    console.log('[P2P] Shared Full-Sync gesendet @', roomId.slice(0, 8));
  },

  async onFullSync(payload, peerId, roomId) {
    if (rememberSyncEvent(payload?.eventId)) return;
    forwardSyncEvent('full-sync', payload, roomId, peerId);
    if (!roomId || roomId === state.masterKeyHash) return; // Main-Room hat eigenen Handler
    if (!payload?.notebooks?.length) return;
    // Shared Full-Sync: notebookId aus Payload kann unterschiedlich sein → per roomId mappen
    const localNbId = _resolveNbId(null, roomId);
    if (!localNbId) return;
    const remote = payload.notebooks[0];
    // Payload-notebookId temporär auf localNbId mappen für applyFullSync
    remote.id = localNbId;
    if (peerId !== 'relay') markSyncActivity('recv:full-sync-shared');
    await applyFullSync(payload);
    if (localNbId === state.currentNotebookId) {
      const cp = currentPage();
      if (cp) { await loadPage(localNbId, cp.id, cp); redrawStrokes(); }
    }
    renderUI();
  },
};

const _mainP2pCallbacks = {
  onStroke: _p2pCallbacks.onStroke,
  onUndo: _p2pCallbacks.onUndo,
  onRedo: _p2pCallbacks.onRedo,
  onEdit: _p2pCallbacks.onEdit,
  onBatch: _p2pCallbacks.onBatch,
  onClear: _p2pCallbacks.onClear,

  async onFullSync(payload, peerId) {
    if (rememberSyncEvent(payload?.eventId)) return;
    console.log('[P2P] Full-Sync von', peerId, ':', payload.notebooks?.length, 'Notebooks');
    if (peerId !== 'relay') markSyncActivity('recv:full-sync-main');
    await applyFullSync(payload);

    // Duplikat-Notebooks entfernen: gleicher Name, verschiedene ID → ältere behalten (niedrigere ID = früher erstellt)
    if (payload.notebooks?.length > 0) {
      const byName = {};
      for (const nb of state.notebooks) {
        if (!byName[nb.name]) byName[nb.name] = [];
        byName[nb.name].push(nb);
      }
      const toRemove = [];
      for (const [name, nbs] of Object.entries(byName)) {
        if (nbs.length <= 1) continue;
        // Ältestes behalten (niedrigste ID = frühester Timestamp)
        nbs.sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
        // Strokes des Ältesten mit den Duplikaten mergen, dann Duplikate löschen
        const keeper = nbs[0];
        for (let i = 1; i < nbs.length; i++) {
          const dup = nbs[i];
          // Events der Duplikat-Pages in den Keeper mergen
          for (const dp of dup.pages) {
            const kp = keeper.pages.find(p => p.id === dp.id);
            if (!kp) {
              keeper.pages.push(dp);
            } else if (dp.events?.length) {
              mergePageEvents(kp, dp.events);
            } else {
              normalizePageStrokes(kp, dp.strokes || []);
            }
          }
          toRemove.push(dup.id);
        }
      }
      if (toRemove.length > 0) {
        for (const id of toRemove) {
          state.notebooks = state.notebooks.filter(n => n.id !== id);
          delete state.currentPageIds[id];
          deleteNotebookData(id);
        }
        if (!state.notebooks.find(n => n.id === state.currentNotebookId)) {
          state.currentNotebookId = state.notebooks[0]?.id;
          state.currentPageIds[state.currentNotebookId] = state.notebooks[0]?.pages?.[0]?.id || null;
        }
        await saveAppMeta();
        console.log('[P2P] Duplikat-Notebooks entfernt:', toRemove.length);
      }
    }

    renderUI();
    const page = currentPage();
    if (page) {
      await loadPage(state.currentNotebookId, page.id, page);
      redrawStrokes();
    }
  },

  onNbCreated(payload, peerId) {
    if (rememberSyncEvent(payload?.eventId)) return;
    const { id, name } = payload;
    if (state.notebooks.find(n => n.id === id)) return;
    state.notebooks.push({ id, name, pages: [] });
    state.currentPageIds[id] = null;
    saveAppMeta();
    renderUI();
    console.log('[P2P] Notebook erstellt von Peer:', name);
  },

  onNbDeleted(payload, peerId) {
    if (rememberSyncEvent(payload?.eventId)) return;
    const { id } = payload;
    const delNb = state.notebooks.find(n => n.id === id);
    if (delNb) delNb.pages.forEach(p => relayDelete(`p:${id}/${p.id}`));
    state.notebooks = state.notebooks.filter(n => n.id !== id);
    delete state.currentPageIds[id];
    if (state.currentNotebookId === id && state.notebooks.length > 0) {
      state.currentNotebookId = state.notebooks[0].id;
      state.currentPageIds[state.currentNotebookId] = state.notebooks[0]?.pages?.[0]?.id || null;
      const page = currentPage();
      if (page) loadPage(state.currentNotebookId, page.id, page).then(() => {
        redrawBackground(); redrawStrokes();
      });
    }
    deleteNotebookData(id);
    saveAppMeta();
    renderUI();
  },

  onNbRenamed(payload, peerId) {
    if (payload?.__presence) {
      upsertPresence(payload.notebookId, payload.deviceId, payload.ts || Date.now());
      renderUI();
      return;
    }
    if (rememberSyncEvent(payload?.eventId)) return;
    const { id, name } = payload;
    const nb = state.notebooks.find(n => n.id === id);
    if (nb) nb.name = name;
    saveAppMeta();
    renderUI();
  },

  onPageCreated() {},

  onPageDeleted() {},

  onPageRestored() {},

  onPageBg(payload, peerId, roomId) {
    if (rememberSyncEvent(payload?.eventId)) return;
    let { notebookId, pageId, background } = payload;
    notebookId = _resolveNbId(notebookId, roomId);
    const nb = state.notebooks.find(n => n.id === notebookId);
    if (!nb) return;
    const page = nb.pages.find(p => p.id === pageId);
    if (!page || isPageDeleted(page)) return;
    page.background = background;
    saveAppMeta();
    if (notebookId === state.currentNotebookId && page.id === currentPage()?.id) {
      redrawBackground();
    }
    renderUI();
  },

  onPeerJoin(peerId) {
    if (!state.connectedPeers.includes(peerId)) state.connectedPeers.push(peerId);
    renderUI();
    updateSyncDebug('peer-join');
    // Full-Sync an neuen Peer senden
    const payload = buildFullSyncPayload({ notebookIds: [state.currentNotebookId] });
    if (payload.notebooks.length > 0) {
      syncSend('full-sync', payload, { peerId, noRelay: true });
      console.log('[P2P] Full-Sync gesendet an', peerId);
    }
  },

  onPeerLeave(peerId) {
    state.connectedPeers = state.connectedPeers.filter(id => id !== peerId);
    renderUI();
    updateSyncDebug('peer-leave');
  }
};

async function startP2P() {
  await initP2P(state.masterKeyHash, _mainP2pCallbacks);
}

// ─── Pinch-Zoom ─────────────────────────────────────────────────────────────

/** Pinch-Zoom starten (2 Finger erkannt). */
function _startPinch() {
  const ids = Object.keys(pinchState.touches);
  if (ids.length < 2) return;
  const t0 = pinchState.touches[ids[0]];
  const t1 = pinchState.touches[ids[1]];
  pinchState.active = true;
  pinchState.startViewX = state.viewX;
  pinchState.startViewY = state.viewY;
  pinchState.startScale = state.viewScale;
  pinchState.startMidX = (t0.x + t1.x) / 2;
  pinchState.startMidY = (t0.y + t1.y) / 2;
  pinchState.startDist = Math.hypot(t1.x - t0.x, t1.y - t0.y) || 1;
}

/** Pinch-Zoom aktualisieren. */
function _updatePinch() {
  const ids = Object.keys(pinchState.touches);
  if (ids.length < 2) return;
  const t0 = pinchState.touches[ids[0]];
  const t1 = pinchState.touches[ids[1]];
  const dist = Math.hypot(t1.x - t0.x, t1.y - t0.y) || 1;
  const scale = Math.min(8, Math.max(0.2, pinchState.startScale * (dist / pinchState.startDist)));
  const midX = (t0.x + t1.x) / 2;
  const midY = (t0.y + t1.y) / 2;

  // Offset: Container-relative Position
  const container = document.getElementById('canvas-container');
  const rect = container?.getBoundingClientRect();
  const offX = rect ? midX - rect.left : midX;
  const offY = rect ? midY - rect.top : midY;

  const canvasX = (offX - pinchState.startViewX) / pinchState.startScale;
  const canvasY = (offY - pinchState.startViewY) / pinchState.startScale;

  state.viewScale = scale;
  state.viewX = offX - canvasX * scale + (midX - pinchState.startMidX);
  state.viewY = offY - canvasY * scale + (midY - pinchState.startMidY);

  redrawBackground();
  compositeStrokes();
}

/**
 * Mausrad-Zoom auf Canvas-Container.
 * @param {WheelEvent} e
 */
function onWheel(e) {
  if (state.tool !== 'hand') return;
  e.preventDefault();
  const container = document.getElementById('canvas-container');
  const rect = container.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const newScale = Math.min(8, Math.max(0.2, state.viewScale * delta));
  const canvasX = (mouseX - state.viewX) / state.viewScale;
  const canvasY = (mouseY - state.viewY) / state.viewScale;
  state.viewX = mouseX - canvasX * newScale;
  state.viewY = mouseY - canvasY * newScale;
  state.viewScale = newScale;
  redrawBackground();
  compositeStrokes();
}

/** View zurücksetzen: Fit-to-Content oder 1:1 wenn keine Strokes. */
function resetView() {
  fitToContent();
}

// ─── Schublade (Notizbuch-Liste) ────────────────────────────────────────────

/** Notizbuch-Liste ein-/ausblenden. Auslöser ist der Notizbuch-Titel. */
function toggleSidebar(force) {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!sidebar) return;
  const wasOpen = sidebar.classList.contains('sidebar-open');
  const open = typeof force === 'boolean' ? force : !wasOpen;
  if (open === wasOpen) return;
  closePopovers();
  const hadFocus = sidebar.contains(document.activeElement);
  sidebar.classList.toggle('sidebar-open', open);
  overlay?.classList.toggle('active', open);
  const titleBtn = document.getElementById('btn-notebooks');
  titleBtn?.setAttribute('aria-expanded', String(open));
  if (open) {
    renderNotebookList();
    (sidebar.querySelector('.nb.current .nb-select') || document.getElementById('btn-close-sidebar'))?.focus();
  } else if (hadFocus) {
    titleBtn?.focus();
  }
}

// ─── Teilen: Einladen / Beitreten ───────────────────────────────────────────

let _scanStream = null;
let _scanTimer = null;
/** @type {{video: HTMLVideoElement, status: HTMLElement, device: boolean}|null} wo gerade gescannt wird */
let _scanUi = null;

function scanUi(kind) {
  return kind === 'device'
    ? { video: document.getElementById('device-scan-video'), status: document.getElementById('device-scan-status'), device: true }
    : { video: document.getElementById('scan-video'), status: document.getElementById('scan-status'), device: false };
}

function setScanStatus(ui, text) {
  if (!ui?.status) return;
  ui.status.textContent = text || '';
  ui.status.hidden = !text;
}

/** Einladungslink verarbeiten: Notizbuch hinzufügen und dorthin wechseln. */
async function processInviteUrl(url) {
  if (!url || !/#[^\s]+/.test(url)) throw new Error('Kein gültiger Einladungslink');
  const prevHash = location.hash;
  try {
    const u = new URL(url, location.origin);
    history.replaceState(null, '', location.pathname + u.hash);
    const invite = await parseInviteLink();
    history.replaceState(null, '', location.pathname + prevHash);
    if (!invite) throw new Error('Kein gültiger Einladungslink');
    await handleInvite(invite);
    closeDialog('share-modal');
  } catch (e) {
    history.replaceState(null, '', location.pathname + prevHash);
    throw e;
  }
}

/**
 * Gescannten oder eingefügten Code auswerten.
 * Einladung → Notizbuch beitreten. Geräte-Code (Link mit vollem Schlüssel) → nur unter „Geräte“.
 * @param {string} text
 * @param {boolean} device - true: es wird ein Geräte-Code erwartet
 */
async function handleScannedCode(text, device) {
  const t = String(text || '').trim();
  const m = t.match(/#([0-9a-fA-F]{64})$/) || t.match(/^([0-9a-fA-F]{64})$/);
  if (device) {
    if (!m) throw new Error('Das ist kein Geräte-Code.');
    await adoptDeviceKey(m[1].toLowerCase());
    return;
  }
  if (m) throw new Error('Das ist ein Geräte-Code. Er gehört in Einstellungen → Geräte.');
  await processInviteUrl(t);
}

async function scanFrame() {
  const ui = _scanUi;
  if (!_scanStream || !ui?.video) return;
  if (ui.video.readyState >= 2) {
    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const codes = await detector.detect(ui.video);
      if (codes?.length && codes[0].rawValue) {
        setScanStatus(ui, 'QR-Code erkannt …');
        try {
          await handleScannedCode(codes[0].rawValue, ui.device);
          stopScanCamera();
          return;
        } catch (e) {
          setScanStatus(ui, e.message || 'Code nicht erkannt.');
        }
      }
    } catch {}
  }
  if (_scanStream && _scanUi === ui) _scanTimer = setTimeout(scanFrame, 500);
}

async function startScanCamera(kind = 'invite') {
  stopScanCamera();
  const ui = scanUi(kind);
  if (!('BarcodeDetector' in window)) {
    setScanStatus(ui, ui.device
      ? 'Dieser Browser kann QR-Codes nicht lesen. Öffne stattdessen den Sync-Link auf diesem Gerät.'
      : 'Dieser Browser kann QR-Codes nicht lesen. Füge stattdessen den Einladungslink ein.');
    return;
  }
  try {
    setScanStatus(ui, 'Kamera wird vorbereitet …');
    _scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    _scanUi = ui;
    if (ui.video) {
      ui.video.srcObject = _scanStream;
      ui.video.hidden = false;
      await ui.video.play().catch(() => {});
    }
    setScanStatus(ui, 'QR-Code vor die Kamera halten');
    scanFrame();
  } catch (e) {
    setScanStatus(ui, 'Kamera konnte nicht gestartet werden.');
  }
}

function stopScanCamera() {
  if (_scanTimer) { clearTimeout(_scanTimer); _scanTimer = null; }
  if (_scanStream) {
    _scanStream.getTracks().forEach(t => t.stop());
    _scanStream = null;
  }
  const video = _scanUi?.video;
  if (video) {
    video.pause?.();
    video.srcObject = null;
    video.hidden = true;
  }
  _scanUi = null;
}

/** QR-Code aus einer Bilddatei lesen. */
function scanImageFile(kind = 'invite') {
  const ui = scanUi(kind);
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (!('BarcodeDetector' in window)) throw new Error('Dieser Browser kann QR-Codes nicht lesen.');
      const bitmap = await createImageBitmap(file);
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const codes = await detector.detect(bitmap);
      if (!codes?.length) throw new Error('Im Bild wurde kein QR-Code gefunden.');
      await handleScannedCode(codes[0].rawValue, ui.device);
    } catch (e) {
      setScanStatus(ui, e.message || 'Bild konnte nicht gelesen werden.');
    }
  };
  input.click();
}

function setJoinError(msg) {
  const input = document.getElementById('join-link');
  const err = document.getElementById('join-error');
  if (!input || !err) return;
  input.classList.toggle('error', !!msg);
  input.setAttribute('aria-invalid', String(!!msg));
  err.hidden = !msg;
  if (msg) err.textContent = msg;
}

/** „Beitreten“: Link aus dem Eingabefeld übernehmen. */
async function joinFromLinkField() {
  const input = document.getElementById('join-link');
  const btn = document.getElementById('btn-join');
  if (!input) return;
  const value = input.value.trim();
  if (!value) { setJoinError('Bitte einen Einladungslink einfügen.'); input.focus(); return; }
  if (btn) btn.disabled = true;
  try {
    await handleScannedCode(value, false);
    setJoinError('');
    input.value = '';
  } catch (e) {
    setJoinError(/Geräte-Code/.test(e.message || '') ? e.message : 'Das ist kein gültiger Einladungslink.');
    input.focus();
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Reiter „Einladen“ füllen: QR + Link des aktuellen Notizbuchs (NotebookKey im Fragment).
 * Erst hier wird das Notizbuch als geteilt markiert und sein Shared-Room eröffnet —
 * also nur, wenn „Einladen“ wirklich angezeigt wird.
 */
async function prepareShareInvite() {
  const nbId = state.currentNotebookId;
  const nbKey = await getNotebookKey(nbId);
  const nbKeyRaw = await exportKey(nbKey);
  const keyB64 = btoa(String.fromCharCode(...nbKeyRaw));

  // Bei localhost: LAN-IP verwenden
  let origin = location.origin;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    try {
      const res = await fetch('/api/lan-ip').catch(() => null);
      if (res?.ok) {
        const data = await res.json();
        if (data.ip) origin = `${location.protocol}//${data.ip}:${location.port}`;
      }
    } catch {}
  }
  // Format: #nb-{notebookHash}&k={base64(notebookKey)}&name={name}
  const nb = state.notebooks.find(n => n.id === nbId);
  const nbHash = await notebookHash(nbId);
  const url = `${origin}${location.pathname}#nb-${nbHash}&k=${encodeURIComponent(keyB64)}&name=${encodeURIComponent(nb?.name || '')}`;
  const linkInput = document.getElementById('share-link');
  if (linkInput) linkInput.value = url;
  const nameEl = document.getElementById('share-nb-name');
  if (nameEl) nameEl.textContent = nb?.name || 'Notizbuch';
  // QR-Code generieren (qrcode.js API: new QRCode(element, options))
  const qrContainer = document.getElementById('qr-container');
  if (qrContainer && typeof QRCode !== 'undefined') {
    qrContainer.replaceChildren();
    new QRCode(qrContainer, {
      text: url, width: 200, height: 200,
      colorDark: '#14171c', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.L
    });
  }

  // Notebook als geteilt markieren + Daten an shared Relay-Room pushen
  if (!state.sharedNotebooks.has(nbId)) {
    state.sharedNotebooks.add(nbId);
    saveSharedNotebooks();
    renderNotebookList();
  }
  pushSharedNotebook(nbId);
  // P2P-Room für geteiltes Notebook beitreten
  joinSharedNotebookP2P(nbId).catch(e => console.warn('[P2P] Shared join fehlgeschlagen:', e));
}

/**
 * Teilen-Dialog öffnen. Reiter „Einladen“ zeigt QR + Link des aktuellen Notizbuchs,
 * „Beitreten“ nimmt eine Einladung an (und fasst das aktuelle Notizbuch nicht an).
 * @param {'invite'|'join'} [tab]
 */
async function openShareModal(tab = 'invite') {
  const modal = document.getElementById('share-modal');
  if (!modal) return;
  const returnFocus = document.activeElement;
  const join = tab === 'join';
  // Reste eines früheren Aufrufs entfernen — „Einladen“ füllt sich erst, wenn es gezeigt wird
  const linkInput = document.getElementById('share-link');
  if (linkInput) linkInput.value = '';
  document.getElementById('qr-container')?.replaceChildren();
  const nameEl = document.getElementById('share-nb-name');
  if (nameEl) nameEl.textContent = currentNotebook()?.name || 'Notizbuch';
  if (!join) await prepareShareInvite();
  const joinInput = document.getElementById('join-link');
  if (joinInput) joinInput.value = '';
  setJoinError('');
  setScanStatus(scanUi('invite'), '');
  selectTab(document.getElementById('share-dialog'), join ? 'join' : 'invite');
  openDialog('share-modal', { returnFocus, onClose: stopScanCamera, focus: join ? '#join-link' : undefined });
}

function closeShareModal() {
  closeDialog('share-modal');
}

/**
 * Invite-Link aus URL-Fragment parsen.
 * Neues Format: #nb-{hash}&k={base64(notebookKey)}&name={name}
 * Altes Format: #nb={notebookId}&k={base64(notebookKey)}&name={name}
 * @returns {Promise<{notebookId: string|null, key: CryptoKey, name: string, nbHash: string|null}|null>}
 */
async function parseInviteLink() {
  const hash = location.hash;
  if (!hash) return null;
  // Neues Format: #nb-{hash}&k=...
  if (hash.startsWith('#nb-') && hash.includes('&k=')) {
    try {
      const afterNb = hash.slice(4); // nach '#nb-'
      const ampIdx = afterNb.indexOf('&');
      const nbHash = afterNb.slice(0, ampIdx);
      const params = new URLSearchParams(afterNb.slice(ampIdx + 1));
      const keyB64 = params.get('k');
      const name = params.get('name') || 'Geteiltes Notizbuch';
      if (!keyB64) return null;
      const raw = Uint8Array.from(atob(decodeURIComponent(keyB64)), c => c.charCodeAt(0));
      const key = await importKey(raw, true);
      // notebookId wird aus dem Key-Hash abgeleitet — erst nach Meta-Load auflösbar
      return { notebookId: null, key, name, nbHash };
    } catch (e) {
      console.warn('[Share] Invite-Link ungültig:', e);
      return null;
    }
  }
  // Altes Format: #nb={id}&k=...
  if (hash.includes('nb=')) {
    try {
      const params = new URLSearchParams(hash.slice(1));
      const notebookId = params.get('nb');
      const keyB64 = params.get('k');
      const name = params.get('name') || 'Geteiltes Notizbuch';
      if (!notebookId || !keyB64) return null;
      const raw = Uint8Array.from(atob(decodeURIComponent(keyB64)), c => c.charCodeAt(0));
      const key = await importKey(raw, true);
      return { notebookId, key, name, nbHash: null };
    } catch (e) {
      console.warn('[Share] Invite-Link ungültig:', e);
      return null;
    }
  }
  return null;
}

/**
 * Invite-Link verarbeiten: NotebookKey installieren, Notebook erstellen wenn nötig.
 * @param {{notebookId: string|null, key: CryptoKey, name: string, nbHash: string|null}} invite
 */
async function handleInvite(invite) {
  // NotebookId bestimmen: aus Hash suchen oder aus altem Format
  let notebookId = invite.notebookId;

  if (!notebookId && invite.nbHash) {
    // Neues Format: NotebookKey installieren, Hash berechnen, existierendes Notebook suchen
    const keyRaw = await exportKey(invite.key);
    const keyHash = await computeKeyHash(keyRaw);
    // Alle Notebooks durchsuchen
    for (const nb of state.notebooks) {
      if (state.notebookKeys[nb.id]) {
        const h = await notebookHash(nb.id);
        if (h === invite.nbHash) { notebookId = nb.id; break; }
      }
    }
    // Nicht gefunden → neues Notebook erstellen
    if (!notebookId) notebookId = newId();
  }

  // NotebookKey speichern
  state.notebookKeys[notebookId] = invite.key;
  const raw = await exportKey(invite.key);
  localStorage.setItem(`notizbuch:nbKey:${notebookId}`, JSON.stringify(Array.from(raw)));

  // Notebook erstellen wenn nicht vorhanden (ohne Pages — kommen vom Relay)
  let isNew = false;
  if (!state.notebooks.find(n => n.id === notebookId)) {
    state.notebooks.push({
      id: notebookId, name: invite.name,
      pages: []
    });
    state.currentPageIds[notebookId] = null;
    isNew = true;
  }

  // Als geteiltes Notebook markieren + P2P-Room beitreten
  state.sharedNotebooks.add(notebookId);
  saveSharedNotebooks();
  joinSharedNotebookP2P(notebookId).catch(e => console.warn('[P2P] Shared join fehlgeschlagen:', e));

  // Daten aus dem geteilten Relay-Room holen
  try {
    const nbHash = await notebookHash(notebookId);
    console.log('[Share] Fetching from shared room:', nbHash.slice(0, 8));
    const sharedNodes = await fetchRoom(nbHash);
    console.log('[Share] fetchRoom result:', sharedNodes ? Object.keys(sharedNodes).length + ' Blobs' : 'null');
    if (sharedNodes) {
      await mergeSharedNotebookData(notebookId, sharedNodes);
    }
  } catch (e) {
    console.warn('[Share] Relay-Fetch fehlgeschlagen:', e);
  }

  // Falls nach Relay-Merge immer noch keine Pages: eine leere Seite anlegen
  const nb = state.notebooks.find(n => n.id === notebookId);
  if (nb && nb.pages.length === 0) {
    nb.pages.push({ id: newId(), strokes: [], background: 'grid', order: 0, createdAt: Date.now() });
    ensureCurrentPageId(notebookId);
  }

  if (isNew) await saveAppMeta();

  // Zum geteilten Notebook wechseln
  await selectNotebook(notebookId);

  // URL-Fragment auf Notebook-Hash setzen
  await updateUrlHash();
  console.log('[Share] Invite verarbeitet:', invite.name, notebookId);
}

// ─── Geräte-Sync (Einstellungen → Geräte) ───────────────────────────────────

/** Sync-Link dieses Geräts: URL mit vollem MasterKey. */
function deviceSyncUrl() {
  return masterKeyRaw ? `${location.origin}${location.pathname}#${keyHex(masterKeyRaw)}` : '';
}

/**
 * „Gerät hinzufügen“: Sync-Link + QR-Code ein-/ausblenden.
 * Der Code enthält den Schlüssel — er steht nur im DOM, solange der Bereich offen ist.
 */
function togglePairBox(force) {
  const box = document.getElementById('pair-box');
  const btn = document.getElementById('btn-pair-toggle');
  const qr = document.getElementById('sync-qr');
  const linkEl = document.getElementById('sync-link-text');
  if (!box) return;
  const url = deviceSyncUrl();
  const show = (typeof force === 'boolean' ? force : box.hidden) && !!url;
  box.hidden = !show;
  btn?.setAttribute('aria-expanded', String(show));
  qr?.replaceChildren();
  if (linkEl) linkEl.textContent = '';
  if (!show) return;
  toggleDeviceScan(false);
  if (linkEl) linkEl.textContent = url;
  if (qr && typeof QRCode !== 'undefined') {
    new QRCode(qr, {
      text: url, width: 200, height: 200,
      colorDark: '#14171c', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.L
    });
  }
}

/** „Code eines Geräts scannen“: Kamera-Bereich ein-/ausblenden. */
function toggleDeviceScan(force) {
  const box = document.getElementById('device-scan-box');
  const btn = document.getElementById('btn-device-scan');
  if (!box) return;
  const show = typeof force === 'boolean' ? force : box.hidden;
  if (box.hidden === !show) return;
  box.hidden = !show;
  btn?.setAttribute('aria-expanded', String(show));
  if (show) {
    togglePairBox(false);
    startScanCamera('device');
  } else {
    if (_scanUi?.device) stopScanCamera();
    setScanStatus(scanUi('device'), '');
  }
}

/**
 * Schlüssel eines anderen Geräts übernehmen (gescannter Sync-Code).
 * Entspricht dem Öffnen des Sync-Links: Die App lädt mit dem Schlüssel im Fragment neu.
 * @param {string} hex - 64 Hex-Zeichen
 */
async function adoptDeviceKey(hex) {
  if (masterKeyRaw && keyHex(masterKeyRaw) === hex) throw new Error('Dieses Gerät nutzt diesen Schlüssel bereits.');
  stopScanCamera();
  const ok = await confirmDialog({
    title: 'Schlüssel des anderen Geräts übernehmen?',
    text: 'Dieses Gerät zeigt danach dessen Notizbücher. Die bisherigen Notizbücher dieses Geräts gehören zum alten Schlüssel — sichere ihn vorher unter „Daten & Schlüssel“.',
    okLabel: 'Übernehmen'
  });
  if (!ok) throw new Error('Abgebrochen.');
  await commitPendingPageOp();
  try { flushSave(); } catch {}
  history.replaceState(null, '', location.pathname + '#' + hex);
  location.reload();
}

// ─── Export / Import ─────────────────────────────────────────────────────────

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Sicherung (.enc): Export und Import ─────────────────────────────────────
//
// Datei: [16 Bytes Salt][12 Bytes IV][AES-GCM] — Schlüssel per PBKDF2 aus der Passphrase
// (packBackup/unpackBackup in share.js). Inhalt 'notizbuch-backup-v3': MasterKey, NotebookKeys,
// geteilte Notizbücher, Notizbücher mit Seiten-Meta und vollständigem Event-Log.
// Gerätelokale Einstellungen (Theme, ICE, Relay-Adresse, Stiftmodus) stehen nicht darin.
// Passphrase und Schlüssel werden nie protokolliert oder in Hinweisen gezeigt.

const BACKUP_TYPE = 'notizbuch-backup-v3';
const BACKUP_TYPE_V2 = 'notizbuch-backup-v2';
const BACKUP_MIN_PASSPHRASE = 8;
/** sessionStorage-Merker: nach dem Neuladen alles ans Relay/an Peers verteilen (kein Geheimnis). */
const AFTER_RESTORE_KEY = 'notizbuch:nachEinspielen';

/** Inhalt der Sicherung zusammenstellen. Jede Seite wird vorher von der Platte gemischt. */
async function buildBackupPayload() {
  if (!masterKeyRaw) throw new Error('Kein Schlüssel vorhanden.');
  const notebookKeys = {};
  const notebooks = [];
  for (const nb of state.notebooks) {
    notebookKeys[nb.id] = Array.from(await exportKey(await getNotebookKey(nb.id)));
    const pages = [];
    for (const p of nb.pages) {
      await loadPage(nb.id, p.id, p);
      pages.push({ ...pageMeta(p), events: storablePageEvents(p) });
    }
    notebooks.push({ id: nb.id, name: nb.name, pages });
  }
  return {
    type: BACKUP_TYPE,
    exportedAt: new Date().toISOString(),
    masterKey: Array.from(masterKeyRaw),
    notebookKeys,
    // Geteilt = ID in dieser Liste + NotebookKey; der Room ergibt sich aus dem Schlüssel
    sharedNotebooks: [...state.sharedNotebooks].filter(id => id in notebookKeys),
    notebooks
  };
}

/**
 * Dialog „Sicherung exportieren“: Passphrase + Wiederholung. `run(passphrase)` läuft bei
 * gültiger Eingabe; solange bleibt der Dialog offen. Die Felder werden beim Schließen geleert.
 * @param {(passphrase: string) => Promise<void>} run
 * @returns {Promise<boolean>} true, wenn exportiert wurde
 */
function exportPassphraseDialog(run) {
  return new Promise(resolve => {
    let done = false;
    const form = document.getElementById('export-form');
    const pass = document.getElementById('export-pass');
    const pass2 = document.getElementById('export-pass2');
    const err = document.getElementById('export-error');
    const okBtn = document.getElementById('export-ok');
    const setError = (msg, field = null) => {
      err.textContent = msg || '';
      for (const el of [pass, pass2]) {
        const bad = !!msg && el === field;
        el.classList.toggle('error', bad);
        el.setAttribute('aria-invalid', String(bad));
      }
    };
    pass.value = '';
    pass2.value = '';
    okBtn.disabled = false;
    setError('');
    pass.oninput = pass2.oninput = () => setError('');
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (okBtn.disabled) return;
      if (pass.value.length < BACKUP_MIN_PASSPHRASE) {
        setError(`Die Passphrase braucht mindestens ${BACKUP_MIN_PASSPHRASE} Zeichen.`, pass);
        pass.focus();
        return;
      }
      if (pass.value !== pass2.value) {
        setError('Die beiden Eingaben stimmen nicht überein.', pass2);
        pass2.focus();
        return;
      }
      okBtn.disabled = true;
      try {
        await run(pass.value);
        done = true;
        closeDialog('backup-export-modal');
      } catch (e2) {
        // Nur die Fehlerart melden — nie die Eingabe
        console.warn('[Export] fehlgeschlagen:', e2?.name || 'Fehler');
        setError('Die Sicherung konnte nicht erstellt werden.');
      }
      okBtn.disabled = false;
    };
    document.getElementById('export-cancel').onclick = () => closeDialog('backup-export-modal');
    openDialog('backup-export-modal', {
      focus: '#export-pass',
      onClose: () => { pass.value = ''; pass2.value = ''; setError(''); resolve(done); }
    });
  });
}

/** Einstellungen → Daten & Schlüssel → „Alle Notizbücher exportieren“. */
async function exportBackup() {
  try {
    // Ein vorgemerktes Leeren/Löschen gehört in die Sicherung
    await commitPendingPageOp();
    const done = await exportPassphraseDialog(async (passphrase) => {
      const bundle = await packBackup(await buildBackupPayload(), passphrase);
      downloadBlob(new Blob([bundle], { type: 'application/octet-stream' }), 'notizbuch-backup.enc');
    });
    if (done) showToast('Sicherung exportiert (.enc)');
  } catch (e) {
    showToast('Export fehlgeschlagen.', { fehler: true });
  }
}

/** Dateiauswahl für eine Sicherung. @returns {Promise<File|null>} */
function chooseBackupFile() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.enc';
    input.onchange = () => resolve(input.files[0] || null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Strich aus einer alten Sicherung (v2) als Event mit stabiler ID — erneutes Einspielen verdoppelt nichts. */
function strokeToImportEvent(stroke) {
  return {
    id: `import:${stroke.id}`,
    type: 'stroke',
    createdAt: strokeCreatedAt(stroke),
    deviceId: 'import',
    seq: 0,
    stroke
  };
}

/** Notizbücher aus einer Sicherung in eine feste Form bringen (v3: events, v2: strokes → Events). */
function cleanBackupNotebooks(list) {
  return (Array.isArray(list) ? list : []).filter(nb => nb && nb.id != null).map(nb => ({
    id: String(nb.id),
    name: String(nb.name || 'Notizbuch'),
    pages: (Array.isArray(nb.pages) ? nb.pages : []).filter(p => p && p.id != null).map(p => ({
      ...pageMeta({ ...p, id: String(p.id) }),
      events: Array.isArray(p.events)
        ? p.events.filter(e => e && e.id && e.type)
        : (Array.isArray(p.strokes) ? p.strokes.filter(s => s && s.id).map(strokeToImportEvent) : [])
    }))
  }));
}

function cleanBackupKeys(keys) {
  const out = {};
  for (const [id, raw] of Object.entries(keys && typeof keys === 'object' ? keys : {})) {
    if (Array.isArray(raw) && raw.length === 32) out[id] = raw;
  }
  return out;
}

/**
 * Entschlüsselten Inhalt prüfen: Sicherung v3 oder altes Schlüsselbündel (nur Schlüssel, ohne Typ).
 * Wirft bei allem anderen.
 */
async function readBackupObject(obj) {
  const rawArr = obj?.masterKey;
  if (!Array.isArray(rawArr) || rawArr.length !== 32 || rawArr.some(b => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error('kein Schlüssel');
  }
  const full = obj.type === BACKUP_TYPE;
  if (obj.type !== undefined && !full) throw new Error('unbekannter Typ');
  if (full && !Array.isArray(obj.notebooks)) throw new Error('unvollständig');
  const masterRaw = new Uint8Array(rawArr);
  const notebooks = full ? cleanBackupNotebooks(obj.notebooks) : [];
  return {
    full,
    masterRaw,
    hash: await computeKeyHash(masterRaw),
    notebookKeys: cleanBackupKeys(obj.notebookKeys),
    sharedNotebooks: (Array.isArray(obj.sharedNotebooks) ? obj.sharedNotebooks.map(String) : [])
      .filter(id => notebooks.some(nb => nb.id === id)),
    notebooks
  };
}

/** Alte Sicherung (v2: mit dem MasterKey verschlüsselt, materialisierte Striche) mit dem Geräteschlüssel öffnen. */
async function openV2Backup(bytes) {
  if (!masterKeyRaw) return null;
  try {
    const plain = await decrypt(await getMasterCryptoKey(), bytes);
    const obj = JSON.parse(new TextDecoder().decode(plain));
    if (obj?.type !== BACKUP_TYPE_V2 || !Array.isArray(obj.notebooks)) return null;
    return {
      full: true,
      masterRaw: masterKeyRaw,
      hash: state.masterKeyHash,
      notebookKeys: cleanBackupKeys(obj.notebookKeys),
      sharedNotebooks: [],
      notebooks: cleanBackupNotebooks(obj.notebooks)
    };
  } catch {
    return null;
  }
}

function backupSummary(backup) {
  if (!backup.full) return 'Schlüssel aus der Sicherung übernommen';
  const n = backup.notebooks.length;
  const m = backup.notebooks.reduce((sum, nb) => sum + nb.pages.filter(p => !isPageDeleted(p)).length, 0);
  return `Sicherung eingespielt: ${n} ${n === 1 ? 'Notizbuch' : 'Notizbücher'}, ${m} ${m === 1 ? 'Seite' : 'Seiten'}`;
}

/**
 * Notizbücher vollständig verteilen: jede Seite ans Relay und als full-sync an verbundene Geräte,
 * geteilte Notizbücher zusätzlich in ihren Shared-Room.
 */
async function distributeNotebooks(notebookIds) {
  for (const nbId of notebookIds) {
    const nb = state.notebooks.find(n => n.id === nbId);
    if (!nb) continue;
    for (const p of nb.pages) {
      try {
        const data = await serializePageData(p, nb.id);
        relayPut(`p:${nb.id}/${p.id}`, data);
        p2pSendForNotebook('full-sync', {
          eventId: newEventId(),
          notebooks: [{ id: nb.id, name: nb.name, pages: [{ ...pageMeta(p), events: storablePageEvents(p) }] }]
        });
      } catch (e) {
        console.warn('[Import] Seite konnte nicht verteilt werden:', p.id);
      }
    }
    if (state.sharedNotebooks.has(nb.id)) {
      try { await pushSharedNotebook(nb.id); } catch {}
    }
  }
  await saveAppMeta();
}

/**
 * Sicherung in den Bestand mischen (gleicher MasterKey): nichts wird ersetzt.
 * Notizbücher/Seiten per ID, Seiten-Meta über applyPageMeta, Events als Vereinigung.
 */
async function mergeBackup(backup) {
  await commitPendingPageOp();
  await installNotebookKeys(backup.notebookKeys);
  if (!backup.full) { showToast(backupSummary(backup)); return; }

  // Plattenstand betroffener Seiten zuerst einmischen, damit die Vereinigung vollständig ist
  for (const remoteNb of backup.notebooks) {
    const nb = state.notebooks.find(n => n.id === remoteNb.id);
    if (!nb) continue;
    for (const remotePage of remoteNb.pages) {
      const page = nb.pages.find(p => p.id === remotePage.id);
      if (page && !_pagesMergedFromDisk.has(page)) await loadPage(nb.id, page.id, page);
    }
  }

  await applyFullSync({ notebooks: backup.notebooks });

  for (const id of backup.sharedNotebooks) {
    if (state.sharedNotebooks.has(id) || !state.notebooks.some(n => n.id === id)) continue;
    state.sharedNotebooks.add(id);
    saveSharedNotebooks();
    joinSharedNotebookP2P(id).catch(() => {});
  }

  // Geänderte Seiten-Meta (geleert/gelöscht/wiederhergestellt) wirkt erst nach dem Neu-Materialisieren
  const ids = backup.notebooks.map(nb => nb.id);
  for (const id of ids) {
    const nb = state.notebooks.find(n => n.id === id);
    if (!nb) continue;
    nb.pages.forEach(refreshPageMaterializedState);
    ensureCurrentPageId(id);
  }
  renderUI();
  if (currentPage() && bgCanvas) { redrawBackground(); redrawStrokes(); }
  refreshPageOverview(true);
  showToast(backupSummary(backup));
  distributeNotebooks(ids).catch(() => {});
}

/**
 * Sicherung auf einem Gerät ohne Schlüssel einspielen — oder Schlüssel und Daten dieses Geräts
 * ersetzen (nach Rückfrage). Entfernt alles Lokale des bisherigen Schlüssels (Seiten-Dateien,
 * Meta, NotebookKeys, Liste geteilter Notizbücher), schreibt den Inhalt der Sicherung und lädt neu.
 */
async function installBackup(backup) {
  const oldHash = state.masterKeyHash;
  _dataSwapRunning = true;
  try {
    // Offline gehen: Nichts aus der Sicherung darf im Room des alten Schlüssels landen
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    if (_sharedPushTimer) { clearTimeout(_sharedPushTimer); _sharedPushTimer = null; }
    try { leaveRoom(); } catch {}
    try { closeAllLiveChannels(); } catch {}
    try { closeRelay(); } catch {}
    _sharedRoomMap.clear();

    await clearAll();
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('notizbuch:nbKey:')) localStorage.removeItem(key);
    }
    localStorage.removeItem('notizbuch:sharedNotebooks');
    localStorage.removeItem(PENDING_OP_KEY);
    if (oldHash && oldHash !== backup.hash && settingsDB) {
      for (const name of ['currentNotebookId', 'pagePositions', 'color', 'penSizeIndex', 'customColors', 'penDetected', 'penOnlyMode']) {
        try { await settingsDelete(`${oldHash}:${name}`); } catch {}
      }
    }

    saveMasterKeyToStorage(backup.masterRaw, backup.hash);
    state.notebookKeys = {};
    await installNotebookKeys(backup.notebookKeys);
    state.sharedNotebooks = new Set(backup.sharedNotebooks);
    saveSharedNotebooks();
    state.notebooks = backup.notebooks.map(nb => ({
      id: nb.id,
      name: nb.name,
      pages: nb.pages.map(p => ({ ...pageMeta(p), strokes: [], events: p.events }))
    }));
    state.notebooks.forEach(normalizePageOrder);
    state.currentPageIds = {};
    state.currentNotebookId = state.notebooks[0]?.id || null;
    state.notebooks.forEach(nb => ensureCurrentPageId(nb.id));

    for (const nb of state.notebooks) {
      for (const p of nb.pages) {
        _pagesMergedFromDisk.add(p); // die Platte ist leer
        await savePageData(nb.id, String(p.id), await serializePageData(p, nb.id));
      }
    }
    if (state.notebooks.length) await saveAppMeta({ local: true });

    try { if (backup.full) sessionStorage.setItem(AFTER_RESTORE_KEY, '1'); } catch {}
    showToastAfterReload(backupSummary(backup));
    location.reload();
  } catch (e) {
    _dataSwapRunning = false;
    throw e;
  }
}

/**
 * Gewählte Sicherungsdatei einspielen. Drei Fälle: Gerät ohne Schlüssel (einrichten),
 * derselbe Schlüssel (mischen), anderer Schlüssel (nach Rückfrage ersetzen).
 * @param {File} file
 * @returns {Promise<boolean>} true, wenn eingespielt wurde (bzw. die App gerade neu lädt)
 */
async function importBackupFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());

  // Altformat v2: lässt sich direkt mit dem Schlüssel dieses Geräts öffnen — keine Passphrase nötig
  const old = await openV2Backup(bytes);
  if (old) { await mergeBackup(old); return true; }

  let backup = null;
  const entered = await promptDialog({
    title: 'Sicherung importieren',
    text: `Datei: ${file.name}`,
    label: 'Passphrase der Sicherung',
    type: 'password',
    okLabel: 'Weiter',
    pruefen: async (value) => {
      try {
        backup = await readBackupObject(await unpackBackup(bytes, value));
      } catch {
        backup = null;
        return 'Die Datei lässt sich damit nicht öffnen — falsche Passphrase oder keine passende Sicherung.';
      }
    }
  });
  if (!entered || !backup) return false;

  if (!masterKeyRaw) { await installBackup(backup); return true; }
  if (keyHex(masterKeyRaw) === keyHex(backup.masterRaw)) { await mergeBackup(backup); return true; }

  const n = state.notebooks.length;
  const ok = await confirmDialog({
    title: 'Schlüssel und Notizbücher dieses Geräts ersetzen?',
    text: `Die Sicherung gehört zu einem anderen Schlüssel. Beim Einspielen werden der Schlüssel und ${n === 1 ? 'das lokale Notizbuch' : `alle ${n} lokalen Notizbücher`} dieses Geräts ersetzt. Verloren geht alles, was nicht auf einem anderen Gerät mit dem bisherigen Schlüssel liegt. Dieses Gerät zeigt danach nur noch die Notizbücher aus der Sicherung.`,
    okLabel: 'Ersetzen'
  });
  if (!ok) return false;
  // Letzten Stand noch unter dem alten Schlüssel festschreiben und abgeben
  await commitPendingPageOp();
  if (_saveTimer) { clearTimeout(_saveTimer); try { await _flushSave(); } catch {} }
  await installBackup(backup);
  return true;
}

/** Einstellungen → Daten & Schlüssel → „Sicherung importieren“. */
async function importBackup() {
  const file = await chooseBackupFile();
  if (!file) return;
  try {
    await importBackupFile(file);
  } catch (e) {
    console.warn('[Import] fehlgeschlagen:', e?.name || 'Fehler');
    showToast('Import fehlgeschlagen.', { fehler: true });
  }
}

async function exportCurrentPageAsPng() {
  const nb = currentNotebook();
  const page = currentPage();
  if (!nb || !page) { showToast('Keine Seite aktiv.', { fehler: true }); return; }
  await loadPage(nb.id, page.id, page);

  const bounds = computeStrokeBounds();
  const margin = 24;
  const fallbackW = Math.max(1, Math.round((staticCanvas?.width || 1200) / DPR));
  const fallbackH = Math.max(1, Math.round((staticCanvas?.height || 1600) / DPR));
  const worldW = bounds ? Math.max(1, Math.ceil(bounds.maxX - bounds.minX + margin * 2)) : fallbackW;
  const worldH = bounds ? Math.max(1, Math.ceil(bounds.maxY - bounds.minY + margin * 2)) : fallbackH;
  const targetMaxDim = 2560;
  const exportScale = Math.max(1, targetMaxDim / Math.max(worldW, worldH));
  const contentW = Math.max(1, Math.round(worldW * exportScale));
  const contentH = Math.max(1, Math.round(worldH * exportScale));
  const offsetX = bounds ? margin - bounds.minX : 0;
  const offsetY = bounds ? margin - bounds.minY : 0;

  const canvas = document.createElement('canvas');
  canvas.width = contentW;
  canvas.height = contentH;
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, contentW, contentH, page.background || 'grid', offsetX * exportScale, offsetY * exportScale, exportScale);
  // Papier unter die Linien legen (drawBackground leert die Fläche zuerst)
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, contentW, contentH);
  ctx.globalCompositeOperation = 'source-over';
  // Striche auf eine eigene transparente Ebene: Füllflächen legen sich per 'destination-over'
  // unter das schon Gezeichnete — direkt auf dem Papier lägen sie unsichtbar darunter.
  const layerCanvas = document.createElement('canvas');
  layerCanvas.width = contentW;
  layerCanvas.height = contentH;
  const layer = layerCanvas.getContext('2d');
  layer.scale(exportScale, exportScale);
  layer.translate(offsetX, offsetY);
  for (const stroke of materializePage(page)) {
    drawStrokeToCanvas(layer, stroke);
  }
  ctx.drawImage(layerCanvas, 0, 0);

  const filename = `${(nb.name || 'notizbuch').replace(/[^a-z0-9-_]+/gi, '_')}-seite-${currentPageIndex() + 1}.png`;
  canvas.toBlob(blob => {
    if (!blob) { showToast('PNG-Export fehlgeschlagen.', { fehler: true }); return; }
    downloadBlob(blob, filename);
    showToast('Seite als PNG gespeichert');
  }, 'image/png');
}


function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function strokeToSvgPath(points = []) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
}

async function exportCurrentPageAsSvg() {
  const nb = currentNotebook();
  const page = currentPage();
  if (!nb || !page) { showToast('Keine Seite aktiv.', { fehler: true }); return; }
  await loadPage(nb.id, page.id, page);

  const bounds = computeStrokeBounds();
  const margin = 24;
  const minX = bounds ? bounds.minX - margin : 0;
  const minY = bounds ? bounds.minY - margin : 0;
  const width = bounds ? Math.max(1, Math.ceil(bounds.maxX - bounds.minX + margin * 2)) : Math.max(1, Math.round((staticCanvas?.width || 1200) / DPR));
  const height = bounds ? Math.max(1, Math.ceil(bounds.maxY - bounds.minY + margin * 2)) : Math.max(1, Math.round((staticCanvas?.height || 1600) / DPR));
  const visibleStrokes = materializePage(page);

  let bgMarkup = '<rect width="100%" height="100%" fill="#ffffff"/>';
  if (page.background === 'grid' || page.background === 'lined') {
    const spacing = 25;
    const lines = [];
    const startY = Math.floor(minY / spacing) * spacing;
    for (let y = startY; y <= minY + height + spacing; y += spacing) {
      lines.push(`<line x1="${minX}" y1="${y}" x2="${minX + width}" y2="${y}" stroke="rgba(180,200,220,0.4)" stroke-width="0.5"/>`);
    }
    if (page.background === 'grid') {
      const startX = Math.floor(minX / spacing) * spacing;
      for (let x = startX; x <= minX + width + spacing; x += spacing) {
        lines.push(`<line x1="${x}" y1="${minY}" x2="${x}" y2="${minY + height}" stroke="rgba(180,200,220,0.35)" stroke-width="0.5"/>`);
      }
    }
    bgMarkup += lines.join('');
  }

  const svgParts = [];
  const eraserMaskParts = ['<mask id="eraser-mask"><rect width="100%" height="100%" fill="white"/>'];
  const fills = [];   // { stroke, idx } in zeitlicher Folge
  const erasers = []; // { idx, markup }
  for (const [idx, stroke] of visibleStrokes.entries()) {
    // Füllflächen liegen im Bild unter allem anderen — sie kommen gesammelt vor die übrigen Elemente
    if (stroke.tool === 'fill') {
      if (isValidFill(stroke)) fills.push({ stroke, idx });
      continue;
    }
    // Formen als echte SVG-Elemente
    if (stroke.tool === 'shape' && stroke.shape) {
      svgParts.push(shapeToSvg(stroke, escapeXml(stroke.color || '#000000'), stroke.fill ? escapeXml(stroke.fill) : null));
      continue;
    }
    const pts = stroke.points || [];
    if (pts.length < 2) continue;
    const path = strokeToSvgPath(pts);
    const widthPx = stroke.tool === 'eraser' ? stroke.size * 3 : stroke.size;
    if (stroke.tool === 'eraser') {
      const markup = `<path d="${path}" fill="none" stroke="black" stroke-linecap="round" stroke-linejoin="round" stroke-width="${widthPx}"/>`;
      eraserMaskParts.push(markup);
      erasers.push({ idx, markup });
    } else {
      svgParts.push(`<path d="${path}" fill="none" stroke="${escapeXml(stroke.color || '#000000')}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${widthPx}"/>`);
    }
  }
  eraserMaskParts.push('</mask>');
  const hasEraser = visibleStrokes.some(s => s.tool === 'eraser');
  // Füllflächen: die jüngste zuunterst (wie 'destination-over' im Bild). Auf eine Füllfläche wirken
  // nur Radierer, die NACH ihr kamen — früher Wegradiertes füllt sie mit. Dafür je Stand eine eigene Maske.
  const fillMasks = new Map(); // Anzahl späterer Radierer → Masken-ID
  const fillParts = [];
  for (const { stroke, idx } of [...fills].reverse()) {
    const later = erasers.filter(e => e.idx > idx);
    let attr = '';
    if (later.length) {
      if (!fillMasks.has(later.length)) fillMasks.set(later.length, { id: `fill-eraser-mask-${fillMasks.size + 1}`, later });
      attr = ` mask="url(#${fillMasks.get(later.length).id})"`;
    }
    fillParts.push(`<g${attr}>${fillToSvg(stroke, escapeXml(stroke.color || '#000000'))}</g>`);
  }
  const fillMaskMarkup = [...fillMasks.values()].map(m =>
    `<mask id="${m.id}" maskUnits="userSpaceOnUse" x="${minX}" y="${minY}" width="${width}" height="${height}"><rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="white"/>${m.later.map(e => e.markup).join('')}</mask>`
  ).join('');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" width="${width}" height="${height}">
  <title>${escapeXml(nb.name || 'Notizbuch')} – Seite ${currentPageIndex() + 1}</title>
  <defs>${hasEraser ? eraserMaskParts.join('') : ''}${fillMaskMarkup}</defs>
  ${bgMarkup}
  ${fillParts.join('')}
  <g${hasEraser ? ' mask="url(#eraser-mask)"' : ''}>
    ${svgParts.join('')}
  </g>
</svg>`;

  const filename = `${(nb.name || 'notizbuch').replace(/[^a-z0-9-_]+/gi, '_')}-seite-${currentPageIndex() + 1}.svg`;
  downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), filename);
  showToast('Seite als SVG gespeichert');
}

/**
 * Aktuelle Seite als Bild exportieren.
 * @param {'png'|'svg'} mode
 */
async function exportApp(mode) {
  try {
    if (mode === 'png') await exportCurrentPageAsPng();
    else if (mode === 'svg') await exportCurrentPageAsSvg();
  } catch (e) {
    showToast('Export fehlgeschlagen: ' + (e?.message || e), { fehler: true });
  }
}

function copyShareLink(e) {
  const link = document.getElementById('share-link')?.value;
  if (link) copyText(link, e?.currentTarget || document.getElementById('btn-copy-link'));
}

// ─── Einstellungen (Allgemein, Geräte, Verbindung, Daten & Schlüssel) ───────

const RELAY_SETTING_KEY = 'device:relayUrl';

/** Text für „verbundene Geräte“ — Namen kennt die App nicht, nur die Anzahl. */
function deviceCountText() {
  const n = state.connectedPeers.length;
  if (n > 0) return `Gerade direkt verbunden: ${n} ${n === 1 ? 'Gerät' : 'Geräte'}.`;
  return 'Gerade ist kein weiteres Gerät direkt verbunden.';
}

function setRelayError(msg) {
  const input = document.getElementById('conn-relay-url');
  const err = document.getElementById('conn-relay-error');
  if (!input || !err) return;
  input.classList.toggle('error', !!msg);
  input.setAttribute('aria-invalid', String(!!msg));
  err.hidden = !msg;
  err.textContent = msg || '';
}

function relayStatusText() {
  return `Relay: ${isRelayConnected() ? 'verbunden' : 'nicht verbunden'}${getCustomRelayUrl() ? ' (eigene Adresse)' : ''} · ${getIceStatus()}`;
}

/** Schlüssel in „Daten & Schlüssel“ ein-/ausblenden (steht nur sichtbar im DOM). */
function toggleKeyBox(force) {
  const box = document.getElementById('key-box');
  const btn = document.getElementById('btn-key-show');
  if (!box) return;
  const show = (typeof force === 'boolean' ? force : box.hidden) && !!masterKeyRaw;
  box.hidden = !show;
  box.textContent = show ? groupHex(keyHex(masterKeyRaw)) : '';
  if (btn) {
    btn.setAttribute('aria-expanded', String(show));
    const label = btn.querySelector('[data-label]');
    if (label) label.textContent = show ? 'Verbergen' : 'Anzeigen';
  }
}

/** Felder der Einstellungen mit dem aktuellen Stand füllen. */
function fillSettings() {
  const theme = getTheme();
  document.querySelectorAll('#theme-seg [data-choice]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.choice === theme)));
  const penSw = document.getElementById('set-pen-only');
  if (penSw) penSw.checked = state.penOnlyMode;
  const diagSw = document.getElementById('set-diag');
  if (diagSw) diagSw.checked = isSyncDebugOn();
  const devStatus = document.getElementById('set-device-status');
  if (devStatus) devStatus.textContent = deviceCountText();

  const urlInput = document.getElementById('conn-turn-url');
  const userInput = document.getElementById('conn-turn-user');
  const passInput = document.getElementById('conn-turn-pass');
  settingsGet('device:iceSettings').then(s => {
    if (urlInput) urlInput.value = s?.turnUrl || '';
    if (userInput) userInput.value = s?.username || '';
    if (passInput) passInput.value = s?.credential || '';
  }).catch(() => {});
  const relayInput = document.getElementById('conn-relay-url');
  if (relayInput) {
    relayInput.value = getCustomRelayUrl();
    relayInput.placeholder = defaultRelayUrl();
  }
  const relayDefault = document.getElementById('conn-relay-default');
  if (relayDefault) relayDefault.textContent = defaultRelayUrl();
  setRelayError('');
  const status = document.getElementById('conn-status');
  if (status) status.textContent = relayStatusText();

  const version = document.getElementById('settings-version');
  if (version) version.textContent = `Version ${APP_VERSION}`;
  togglePairBox(false);
  toggleDeviceScan(false);
  toggleKeyBox(false);
}

/**
 * Einstellungen öffnen.
 * @param {'general'|'devices'|'connection'|'data'} [section]
 */
function openSettings(section = 'general') {
  const returnFocus = document.activeElement;
  fillSettings();
  selectTab(document.getElementById('settings-sheet'), section);
  openDialog('settings-modal', { returnFocus, onClose: onSettingsClosed });
  toggleSidebar(false);
}

/** Beim Schließen: Kamera aus, Schlüssel und Sync-Code wieder aus dem DOM. */
function onSettingsClosed() {
  togglePairBox(false);
  toggleDeviceScan(false);
  toggleKeyBox(false);
}

/**
 * Relay-Verbindungen mit der aktuell eingestellten Adresse neu aufbauen:
 * Live-Kanäle (Haupt-Room + Shared-Rooms) schließen und neu öffnen, danach
 * kompletter Resync (Haupt-Room holen/mergen/pushen, Shared-Rooms nachziehen).
 */
async function rebuildRelayConnections() {
  const waitWhile = async (cond, maxMs) => {
    for (let t = 0; t < maxMs && cond(); t += 100) await new Promise(r => setTimeout(r, 100));
  };
  try { flushSave(); } catch {}
  closeAllLiveChannels();
  // Ein laufender Resync könnte noch die alte Adresse benutzt haben — erst abwarten
  await waitWhile(() => _resyncRunning, 15000);
  openMainLiveChannel();
  for (const nbHash of _sharedRoomMap.values()) openLiveChannel(nbHash, onLiveEvent);
  // Erst weitermachen, wenn die neuen Kanäle verbunden oder gescheitert sind:
  // resync() ruft reconnectLiveChannels(), das einen noch verbindenden Kanal abbrechen würde.
  await waitWhile(() => liveChannelStatus().some(ch => ch.state === 'verbindet'), 6000);
  _lastSharedResyncAt = 0;
  await resync();
  updateSyncStatus();
  updateSyncDebug('relay-url');
}

/** Relay-Adresse gerätelokal speichern ('' = Standard) und Verbindungen neu aufbauen. */
async function applyRelayUrl(url) {
  if (url) await settingsPut(RELAY_SETTING_KEY, url);
  else await settingsDelete(RELAY_SETTING_KEY);
  setRelayUrl(url);
  await rebuildRelayConnections();
}

/** „Standard wiederherstellen“: eigene Relay-Adresse verwerfen. */
async function restoreDefaultRelay() {
  const input = document.getElementById('conn-relay-url');
  const status = document.getElementById('conn-status');
  if (input) input.value = '';
  setRelayError('');
  if (!getCustomRelayUrl()) {
    if (status) status.textContent = 'Der Standard gilt bereits. ' + relayStatusText();
    return;
  }
  if (status) status.textContent = 'Standard-Relay wird verbunden …';
  await applyRelayUrl('');
  if (status) status.textContent = 'Standard wiederhergestellt. ' + relayStatusText();
}

/**
 * „Speichern“ im Abschnitt Verbindung: Relay-Adresse prüfen und übernehmen,
 * TURN/ICE speichern. Geänderte ICE-Einstellungen brauchen ein Neuladen.
 */
async function saveConnectionSettings() {
  const urlInput = document.getElementById('conn-turn-url');
  const userInput = document.getElementById('conn-turn-user');
  const passInput = document.getElementById('conn-turn-pass');
  const relayInput = document.getElementById('conn-relay-url');
  const status = document.getElementById('conn-status');

  const relay = (relayInput?.value || '').trim();
  if (relay && !isValidRelayUrl(relay)) {
    setRelayError('Bitte eine Adresse angeben, die mit wss:// oder ws:// beginnt.');
    relayInput?.focus();
    return;
  }
  const relayProblem = relay ? relayUrlProblem(relay) : '';
  if (relayProblem) {
    setRelayError(relayProblem);
    relayInput?.focus();
    return;
  }
  setRelayError('');

  const settings = {
    turnUrl: (urlInput?.value || '').trim(),
    username: (userInput?.value || '').trim(),
    credential: (passInput?.value || '').trim()
  };
  const prev = await settingsGet('device:iceSettings') || {};
  const iceChanged = (prev.turnUrl || '') !== settings.turnUrl
    || (settings.turnUrl && ((prev.username || '') !== settings.username || (prev.credential || '') !== settings.credential));
  const relayChanged = relay !== getCustomRelayUrl();

  if (iceChanged) {
    if (!settings.turnUrl) {
      // Leere Eingabe = Einstellung entfernen
      await settingsDelete('device:iceSettings');
      setIceSettings({});
    } else {
      await settingsPut('device:iceSettings', settings);
      setIceSettings(settings);
    }
    if (relayChanged) {
      if (relay) await settingsPut(RELAY_SETTING_KEY, relay);
      else await settingsDelete(RELAY_SETTING_KEY);
    }
    // Trystero hält Offer-Pool und geteilte Peer-Verbindungen modulweit mit der
    // Konfiguration des ersten Room-Beitritts. Ein Rejoin übernimmt neue
    // ICE-Server daher nicht zuverlässig — nur ein Neuladen tut das.
    closeDialog('settings-modal');
    try { flushSave(); } catch {}
    location.reload();
    return;
  }

  if (relayChanged) {
    if (status) status.textContent = 'Gespeichert – Relay wird neu verbunden …';
    await applyRelayUrl(relay);
  }
  if (status) status.textContent = 'Gespeichert. ' + relayStatusText();
}

// ─── Settings Persistence ───────────────────────────────────────────────────

async function saveLocalSettings() {
  if (!settingsDB) return;
  try {
    // Prüfen ob DB noch offen ist
    settingsDB.transaction('settings', 'readonly');
  } catch {
    try { settingsDB = await openSettingsDB(); } catch { return; }
  }
  await settingsPut(state.masterKeyHash + ':currentNotebookId', state.currentNotebookId);
  await settingsPut(state.masterKeyHash + ':pagePositions', { ...state.currentPageIds });
  await settingsPut(state.masterKeyHash + ':color', state.color);
  await settingsPut(state.masterKeyHash + ':penSizeIndex', state.penSizeIndex);
  await settingsPut(state.masterKeyHash + ':shapeType', state.shapeType);
  await settingsPut(state.masterKeyHash + ':customColors', [...state.customColors]);
  await settingsPut(state.masterKeyHash + ':penDetected', state.penDetected);
  await settingsPut(state.masterKeyHash + ':penOnlyMode', state.penOnlyMode);
}

async function loadLocalSettings() {
  const savedCurrentId = await settingsGet(state.masterKeyHash + ':currentNotebookId');
  const savedColor = await settingsGet(state.masterKeyHash + ':color');
  // Weiß gibt es nicht mehr (Papier ist immer weiß) → Standardfarbe
  if (savedColor && String(savedColor).toLowerCase() !== '#ffffff') state.color = savedColor;
  const savedPenSizeIndex = await settingsGet(state.masterKeyHash + ':penSizeIndex');
  if (typeof savedPenSizeIndex === 'number') state.penSizeIndex = savedPenSizeIndex;
  const savedShapeType = await settingsGet(state.masterKeyHash + ':shapeType');
  if (SHAPE_TYPES.includes(savedShapeType)) state.shapeType = savedShapeType;
  const savedCustomColors = await settingsGet(state.masterKeyHash + ':customColors');
  if (Array.isArray(savedCustomColors)) state.customColors = savedCustomColors.filter(c => String(c).toLowerCase() !== '#ffffff');
  const savedPenDetected = await settingsGet(state.masterKeyHash + ':penDetected');
  if (typeof savedPenDetected === 'boolean') state.penDetected = savedPenDetected;
  const savedPenOnlyMode = await settingsGet(state.masterKeyHash + ':penOnlyMode');
  if (typeof savedPenOnlyMode === 'boolean') state.penOnlyMode = savedPenOnlyMode;
  return savedCurrentId;
}

// ─── Input Handling ─────────────────────────────────────────────────────────

/**
 * Pointer-Position relativ zum Canvas-Container.
 * @param {PointerEvent} e
 * @returns {{x: number, y: number}}
 */
function getCanvasPos(e) {
  const container = document.getElementById('canvas-container');
  const rect = container.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
}

/**
 * Screen-Koordinaten → World-Koordinaten.
 * @param {number} sx
 * @param {number} sy
 * @returns {{x: number, y: number}}
 */
function screenToWorld(sx, sy) {
  return {
    x: (sx - state.viewX) / state.viewScale,
    y: (sy - state.viewY) / state.viewScale
  };
}

// ─── Pan State ──────────────────────────────────────────────────────────────

/** Umschalt beim Aufziehen einer Form gehalten (Stand der letzten Bewegung) */
let _shapeConstrain = false;

let isPanning = false;
let panStartX = 0, panStartY = 0;
let panStartViewX = 0, panStartViewY = 0;
let panPointerId = null;

function onPointerDown(e) {
  if (isPageGone()) return;
  // Die Auswahl-Leiste liegt in der Zeichenfläche — Tipps darauf sind keine Zeichen-Eingabe
  if (e.target?.closest?.('.selbar')) return;
  // Palm-Rejection: Pen erkannt → Touch ignorieren für Zeichnen
  if (e.pointerType === 'pen') {
    state.penDetected = true;
  }

  // Touch-Handling
  if (e.pointerType === 'touch') {
    // Hand-Tool → Pan/Pinch (kein Swipe)
    if (state.tool === 'hand') {
      pinchState.touches[e.pointerId] = { x: e.clientX, y: e.clientY };
      const touchCount = Object.keys(pinchState.touches).length;
      if (touchCount >= 2) {
        if (!pinchState.active) _startPinch();
        return;
      }
      isPanning = true;
      panPointerId = e.pointerId;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartViewX = state.viewX;
      panStartViewY = state.viewY;
      return;
    }
    // Stiftmodus aktiv → Finger-Zeichnen komplett blockieren
    if (state.penOnlyMode) return;
    // Pen/Eraser-Tool → 1 Finger zeichnet (fällt durch zum Drawing-Code)
  }

  // Hand-Tool → Panning
  if (state.tool === 'hand') {
    isPanning = true;
    panPointerId = e.pointerId;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartViewX = state.viewX;
    panStartViewY = state.viewY;
    e.target?.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    return;
  }

  if (isDrawing) return;
  const pos = getCanvasPos(e);
  const world = screenToWorld(pos.x, pos.y);

  // Auswahl-Werkzeug: Objekt antippen, verschieben, an den Griffen ziehen
  if (state.tool === 'select') {
    selectPointerDown(e, pos, world);
    if (_selDrag?.pointerId === e.pointerId) e.target?.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    return;
  }

  // Füllen: ein Tipp (ohne Ziehen) — ausgelöst beim Loslassen
  if (state.tool === 'fill') {
    _fillTap = _fillTap && _fillTap.pointerId !== e.pointerId ? null : { pointerId: e.pointerId, pos };
    if (_fillTap) e.target?.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    return;
  }

  isDrawing = true;
  _shapeConstrain = false;
  activePointerId = e.pointerId;
  activePointerType = e.pointerType;
  currentPoints = [world];
  lastPoint = pos;

  // Live-Preview auf activeCanvas
  if (activeCtx) {
    activeCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    activeCtx.clearRect(0, 0, activeCanvas.width / DPR, activeCanvas.height / DPR);
  }

  e.target?.setPointerCapture?.(e.pointerId);
  e.preventDefault();
}

function onPointerMove(e) {
  // Touch-Position aktualisieren (für Pinch-Berechnung)
  if (pinchState.touches[e.pointerId]) {
    pinchState.touches[e.pointerId] = { x: e.clientX, y: e.clientY };
  }
  // Aktiver Pinch-Zoom → nur Pinch updaten
  if (pinchState.active) {
    _updatePinch();
    return;
  }

  // Panning
  if (isPanning && e.pointerId === panPointerId) {
    state.viewX = panStartViewX + (e.clientX - panStartX);
    state.viewY = panStartViewY + (e.clientY - panStartY);
    redrawBackground();
    compositeStrokes();
    e.preventDefault();
    return;
  }

  if (_selDrag && e.pointerId === _selDrag.pointerId) {
    selectPointerMove(e);
    e.preventDefault();
    return;
  }

  if (!isDrawing || e.pointerId !== activePointerId) return;
  e.preventDefault();

  const pos = getCanvasPos(e);
  const world = screenToWorld(pos.x, pos.y);

  // Form aufziehen: Anfangs- und Endpunkt, Vorschau als fertige Form
  if (state.tool === 'shape') {
    currentPoints = [currentPoints[0], world];
    _shapeConstrain = e.shiftKey;
    if (activeCtx) {
      activeCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
      activeCtx.clearRect(0, 0, activeCanvas.width / DPR, activeCanvas.height / DPR);
      activeCtx.save();
      activeCtx.translate(state.viewX, state.viewY);
      activeCtx.scale(state.viewScale, state.viewScale);
      drawStrokeToCanvas(activeCtx, newShapeStroke(shapeFromDrag(currentPoints[0], world, state.shapeType, _shapeConstrain)));
      activeCtx.restore();
    }
    lastPoint = pos;
    return;
  }

  currentPoints.push(world);

  // Live-Preview zeichnen
  if (activeCtx && lastPoint) {
    activeCtx.beginPath();
    activeCtx.moveTo(lastPoint.x, lastPoint.y);
    activeCtx.lineTo(pos.x, pos.y);
    const size = PEN_SIZES[state.penSizeIndex].size * state.viewScale;
    activeCtx.lineWidth = state.tool === 'eraser' ? size * 3 : size;
    activeCtx.strokeStyle = state.tool === 'eraser' ? 'rgba(128,128,128,0.5)' : state.color;
    activeCtx.lineCap = 'round';
    activeCtx.lineJoin = 'round';
    activeCtx.globalCompositeOperation = 'source-over';
    activeCtx.stroke();
  }
  lastPoint = pos;
}

function onPointerUp(e) {
  // Touch aufräumen
  delete pinchState.touches[e.pointerId];

  // Pinch-Zoom beenden
  if (pinchState.active) {
    if (Object.keys(pinchState.touches).length < 2) {
      pinchState.active = false;
      redrawStrokes(); // Cache nach Zoom aktualisieren
      updateSyncDebug();
    }
    return;
  }

  // Panning beenden
  if (isPanning && e.pointerId === panPointerId) {
    isPanning = false;
    panPointerId = null;
    redrawStrokes(); // Cache aktualisieren
    updateSyncDebug();
    return;
  }

  if (_selDrag && e.pointerId === _selDrag.pointerId) {
    selectPointerUp();
    return;
  }

  if (_fillTap && e.pointerId === _fillTap.pointerId) {
    const tap = _fillTap;
    _fillTap = null;
    if (e.type !== 'pointerup' || state.tool !== 'fill') return;
    const pos = getCanvasPos(e);
    // Weggezogen = kein Tipp
    if (Math.hypot(pos.x - tap.pos.x, pos.y - tap.pos.y) > 12) return;
    fillAtPoint(tap.pos);
    return;
  }

  if (!isDrawing || e.pointerId !== activePointerId) return;
  isDrawing = false;
  activePointerId = null;

  // Active Canvas leeren
  if (activeCtx) {
    activeCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    activeCtx.clearRect(0, 0, activeCanvas.width / DPR, activeCanvas.height / DPR);
  }

  const page = currentPage();
  if (!page || isPageGone(page) || currentPoints.length < 2) { currentPoints = []; lastPoint = null; return; }

  let shape = null;
  if (state.tool === 'shape') {
    shape = shapeFromDrag(currentPoints[0], currentPoints[1], state.shapeType, _shapeConstrain);
    // Winzige Form = versehentlicher Tipp: verwerfen (5 Bildschirm-Pixel)
    if (Math.max(Math.abs(shape.x2 - shape.x1), Math.abs(shape.y2 - shape.y1)) * state.viewScale < 5) {
      currentPoints = [];
      lastPoint = null;
      return;
    }
  }

  // Ein neuer Strich schreibt ein vorgemerktes Leeren sofort fest (clearedAt liegt vor dem Strich)
  if (_pendingPageOp) commitPendingPageOp();

  const newStroke = shape ? newShapeStroke(shape) : {
    id: newId(),
    createdAt: Date.now(),
    points: roundPoints(currentPoints),
    color: state.color,
    size: PEN_SIZES[state.penSizeIndex].size,
    tool: state.tool === 'eraser' ? 'eraser' : 'pen'
  };

  const pageEvent = newPageEvent('stroke', { stroke: newStroke });
  applyPageEvent(page, pageEvent);
  // Ein neuer eigener Strich verwirft den Redo-Stapel dieser Seite
  clearRedoStack(state.currentNotebookId, page.id);
  redrawStrokes();

  saveCurrentPage();
  p2pSendForNotebook('stroke', { eventId: newEventId(), notebookId: state.currentNotebookId, pageId: page.id, stroke: newStroke, pageEvent });
  currentPoints = [];
  lastPoint = null;
}

// ─── UI Rendering ───────────────────────────────────────────────────────────

/** Sidebar + Toolbar + Page-Bar aktualisieren. */
function renderUI() {
  // Zeigt die Zeichenfläche noch die richtige Seite? (aktuelle Seite woanders gelöscht → Nachbarseite)
  reconcileShownPage();

  // Notizbuch-Liste in der Schublade
  renderNotebookList();

  // Notebook-Name im Titel-Knopf (öffnet die Notizbuch-Liste)
  const nbName = currentNotebook()?.name || '';
  // Nur vorübergehend möglich (alle Seiten gelöscht, Ersatzseite noch nicht da)
  const deletedPage = isPageGone();
  const titleEl = document.getElementById('notebook-title');
  if (titleEl) titleEl.textContent = nbName;
  const titleBtn = document.getElementById('btn-notebooks');
  if (titleBtn) titleBtn.setAttribute('aria-label', `Notizbücher öffnen – aktuell: ${nbName}`);

  // Seiten-Pille: Zähler (öffnet die Seitenübersicht), ‹ › — gelöschte Seiten zählen nicht mit
  const pageNo = currentPageIndex() + 1;
  const pageTotal = totalPages();
  const pageIndicator = document.getElementById('page-indicator');
  if (pageIndicator) pageIndicator.textContent = `${pageNo} / ${pageTotal}`;
  const overviewBtn = document.getElementById('btn-page-overview');
  if (overviewBtn) overviewBtn.setAttribute('aria-label', `Seite ${pageNo} von ${pageTotal} – Seitenübersicht öffnen`);
  const prevBtn = document.getElementById('btn-prev');
  const nextBtn = document.getElementById('btn-next');
  if (prevBtn) prevBtn.disabled = pageNo <= 1;
  if (nextBtn) nextBtn.disabled = pageNo >= pageTotal; // „›“ legt keine Seite an — dafür gibt es „+“

  // Seiten-Menü: Leeren/Löschen
  const delPageBtn = document.getElementById('btn-delete-page');
  if (delPageBtn) delPageBtn.disabled = deletedPage;
  const clearBtn = document.getElementById('btn-clear');
  if (clearBtn) clearBtn.disabled = deletedPage;

  updateRedoButton();

  // Vollbild-Eintrag
  const zenLabel = document.getElementById('zen-label');
  if (zenLabel) zenLabel.textContent = state.zenMode ? 'Vollbild verlassen' : 'Vollbild';

  // Papierart
  const curBg = currentPage()?.background || 'grid';
  document.querySelectorAll('.bg-btn[data-bg]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.bg === curBg));
    btn.disabled = deletedPage;
  });

  // Hand-Schalter + Werkzeuge. Bei eingeschalteter Hand bleibt das gemerkte Werkzeug markiert.
  const handOn = state.tool === 'hand';
  const main = document.getElementById('main');
  if (main) main.dataset.mode = handOn ? 'move' : 'draw';
  document.getElementById('btn-hand')?.setAttribute('aria-pressed', String(handOn));
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.tool === state.lastDrawTool));
  });
  // Der Knopf „Formen“ zeigt die gewählte Form
  document.getElementById('shape-icon')?.setAttribute('href', '#i-' + state.shapeType);
  document.querySelectorAll('[data-shape]').forEach(btn => {
    btn.setAttribute('aria-checked', String(btn.dataset.shape === state.shapeType));
  });

  // Canvas-Cursor
  const container = document.getElementById('canvas-container');
  if (container) {
    container.classList.toggle('hand-cursor', handOn);
    container.style.cursor = handOn ? '' : (deletedPage ? 'not-allowed' : (state.tool === 'eraser' ? 'cell' : (state.tool === 'select' ? 'default' : 'crosshair')));
  }

  // Knopf „Farbe“: zeigt die aktuelle Farbe
  const chipColor = document.getElementById('chip-color');
  if (chipColor) chipColor.style.background = state.color;
  const colorBtn = document.getElementById('btn-color');
  if (colorBtn) {
    const idx = COLORS.indexOf(String(state.color).toLowerCase());
    colorBtn.setAttribute('aria-label', `Farbe: ${idx >= 0 ? COLOR_NAMES[idx] : state.color}`);
  }

  // Farb-Popover (Standard + eigene Farben + freie Farbwahl) — nur neu aufbauen, wenn sich die Liste ändert
  const swatchBox = document.getElementById('color-swatches');
  if (swatchBox) {
    const custom = state.customColors.filter(c => !COLORS.includes(c));
    const listKey = custom.join(',');
    if (swatchBox.dataset.key !== listKey || !swatchBox.firstElementChild) {
      swatchBox.dataset.key = listKey;
      const pickerOpen = !document.getElementById('color-picker-popup')?.classList.contains('hidden');
      swatchBox.innerHTML = COLORS.map((c, i) =>
        `<button class="swatch" style="--c:${c}" data-color="${c}" aria-label="${COLOR_NAMES[i]}" title="${COLOR_NAMES[i]}" aria-pressed="false"><i></i></button>`
      ).join('') + custom.filter(c => /^#[0-9a-f]{3,8}$/i.test(c)).map(c =>
        `<button class="swatch" style="--c:${c}" data-color="${c}" aria-label="Eigene Farbe ${c}" title="Eigene Farbe ${c}" aria-pressed="false"><i></i></button>`
      ).join('') + `<button class="swatch custom" id="btn-color-picker" aria-label="Eigene Farbe wählen" title="Eigene Farbe wählen" aria-pressed="${pickerOpen}"><i></i></button>`;
    }
    swatchBox.querySelectorAll('.swatch[data-color]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.color === String(state.color).toLowerCase()));
    });
  }

  // Knopf „Stärke“: zeigt die aktuelle Strichstärke
  const curSize = PEN_SIZES[state.penSizeIndex] || PEN_SIZES[2];
  const chipSize = document.getElementById('chip-size');
  if (chipSize) chipSize.style.width = chipSize.style.height = Math.min(20, curSize.dot) + 'px';
  document.getElementById('btn-size')?.setAttribute('aria-label', `Strichstärke: ${curSize.label}`);

  // Stärke-Popover
  const sizeBox = document.getElementById('size-options');
  if (sizeBox) {
    if (!sizeBox.firstElementChild) {
      sizeBox.innerHTML = PEN_SIZES.map((s, i) =>
        `<button class="size" style="--d:${s.dot}px" data-size="${i}" aria-label="${s.label}" title="${s.label}" aria-pressed="false"><i></i></button>`
      ).join('');
    }
    sizeBox.querySelectorAll('.size').forEach(btn => {
      btn.setAttribute('aria-pressed', String(Number(btn.dataset.size) === state.penSizeIndex));
    });
  }

  updateSyncDebug();
  updateSyncStatus();
  refreshPageOverview();
}

/** Sync-Status in der Leiste (Punkt + Text). Schreibt nur bei Änderung ins DOM. */
let _syncStatusKey = '';
function updateSyncStatus() {
  const el = document.getElementById('sync-status');
  if (!el) return;
  const n = state.connectedPeers.length;
  let cls = 'busy', text = 'Verbindet …';
  if (n > 0) { cls = ''; text = `Verbunden · ${n} ${n === 1 ? 'Gerät' : 'Geräte'}`; }
  else if (isRelayConnected()) { cls = ''; text = 'Online'; }
  else if (navigator.onLine === false) { cls = 'off'; text = 'Offline'; }
  const key = cls + '|' + text;
  if (key === _syncStatusKey) return;
  _syncStatusKey = key;
  el.classList.toggle('busy', cls === 'busy');
  el.classList.toggle('off', cls === 'off');
  const textEl = document.getElementById('sync-text');
  if (textEl) textEl.textContent = text;
  el.setAttribute('aria-label', `Sync-Status: ${text}. Öffnet die Verbindungseinstellungen`);
  el.title = `${text} · Verbindungseinstellungen öffnen`;
  // Statuszeile im Fuß der Schublade: gleicher Stand
  const row = document.getElementById('status-row');
  if (row) {
    row.classList.toggle('busy', cls === 'busy');
    row.classList.toggle('off', cls === 'off');
    row.setAttribute('aria-label', `Sync-Status: ${text}. Öffnet die Verbindungseinstellungen`);
    const rowText = document.getElementById('status-text');
    if (rowText) rowText.textContent = text;
  }
  const devStatus = document.getElementById('set-device-status');
  if (devStatus) devStatus.textContent = deviceCountText();
}

// ─── Init ───────────────────────────────────────────────────────────────────

async function init() {
  console.log('[App] Init...', APP_VERSION);
  updateSyncDebug('init');

  // Dialoge bedienbar machen (der Erststart-Dialog kommt vor setupEvents)
  setupDialogs();

  ensureDeviceId();

  // 1. Storage initialisieren
  const storageBackend = await initStorage();
  console.log('[App] Storage:', storageBackend);

  // 2. Settings-DB öffnen
  settingsDB = await openSettingsDB();

  // 2a. Gespeicherte Theme-Wahl übernehmen (gerätelokal)
  await loadTheme();

  // 3. Invite-Link prüfen (bevor MasterKey-Dialog kommt)
  const invite = await parseInviteLink();

  // 4. MasterKey laden oder generieren (bei Invite: still generieren)
  await initMasterKey(!!invite);

  // 5. Lokale Settings laden
  const savedCurrentId = await loadLocalSettings();

  // 5a. Gerätelokale ICE-/TURN-Einstellungen laden (vor P2P-Start!)
  try {
    const iceSettings = await settingsGet('device:iceSettings') || {};
    setIceSettings({
      turnUrl: iceSettings.turnUrl || '',
      username: iceSettings.username || '',
      credential: iceSettings.credential || ''
    });
  } catch (e) {
    console.warn('[App] ICE-Einstellungen konnten nicht geladen werden:', e);
  }

  // 5a2. Gerätelokale Relay-Adresse laden (vor der ersten Relay-Verbindung!). Ohne Eintrag gilt der Standard.
  try {
    const savedRelay = await settingsGet(RELAY_SETTING_KEY);
    if (isValidRelayUrl(savedRelay)) setRelayUrl(savedRelay);
  } catch (e) {
    console.warn('[App] Relay-Adresse konnte nicht geladen werden:', e);
  }

  // 5b. Geteilte Notebooks laden
  loadSharedNotebooks();

  // 5c. Live-Kanäle öffnen (Haupt-Room)
  openMainLiveChannel();

  // 6. App-Metadaten laden (lokal)
  await loadAppMeta();
  await recoverPendingPageOp();

  // 6b. Relay: verschlüsselte Snapshots laden und mergen
  try {
    const relayNodes = await initRelay(state.masterKeyHash);
    if (relayNodes) await mergeRelayData(relayNodes);
  } catch (e) {
    console.warn('[Relay] Init fehlgeschlagen:', e);
  }

  // 6c. Geteilte Notebooks: Daten aus shared Relay-Rooms holen
  for (const nbId of state.sharedNotebooks) {
    try {
      const nbHash = await notebookHash(nbId);
      const sharedNodes = await fetchRoom(nbHash);
      if (sharedNodes) await mergeSharedNotebookData(nbId, sharedNodes);
    } catch {}
  }

  // 7. Wenn keine Notebooks: Default erstellen
  if (state.notebooks.length === 0) {
    createDefaultNotebook();
    await saveAppMeta();
  }

  // 7b. Invite-Link verarbeiten (nach Meta-Load, damit Notebook-Check funktioniert)
  if (invite) {
    await handleInvite(invite);
  }

  // 7c. Nav-State wiederherstellen
  if (savedCurrentId && state.notebooks.find(n => n.id === savedCurrentId)) {
    state.currentNotebookId = savedCurrentId;
    const pagePositions = await settingsGet(state.masterKeyHash + ':pagePositions') || {};
    for (const nb of state.notebooks) {
      const savedPagePos = pagePositions[nb.id];
      state.currentPageIds[nb.id] = typeof savedPagePos === 'number'
        ? (nb.pages[savedPagePos]?.id || null)
        : (savedPagePos ?? null);
      ensureCurrentPageId(nb.id);
    }
  } else {
    state.currentNotebookId = state.notebooks[0].id;
  }
  for (const nb of state.notebooks) {
    ensureCurrentPageId(nb.id);
  }

  // 7d. URL-Hash #nb-{hash} auswerten (Bookmark/direkter Link, kein Invite)
  if (!invite) {
    const urlHash = location.hash.slice(1);
    if (urlHash.startsWith('nb-') && !urlHash.includes('&')) {
      const nbId = await findNotebookByHash(urlHash.slice(3));
      if (nbId) state.currentNotebookId = nbId;
    }
  }

  // 8. Canvas-Referenzen
  bgCanvas = document.getElementById('bg-canvas');
  staticCanvas = document.getElementById('static-canvas');
  activeCanvas = document.getElementById('active-canvas');
  if (bgCanvas) bgCtx = bgCanvas.getContext('2d');
  if (staticCanvas) staticCtx = staticCanvas.getContext('2d');
  if (activeCanvas) activeCtx = activeCanvas.getContext('2d');

  // 9. Aktuelle Seite laden
  const page = currentPage();
  if (page) await loadPage(state.currentNotebookId, page.id, page);

  // 10. Canvas aufsetzen (mit kurzer Verzögerung damit Layout stabil ist)
  setupCanvases();
  requestAnimationFrame(() => { setupCanvases(); fitToContent(); });

  // 10b. URL-Hash auf aktuelles Notebook setzen
  await updateUrlHash();
  _shownPageKey = pageKey();

  // 11. Event-Listener
  setupEvents();

  // 11b. hashchange-Listener für manuelle Navigation
  window.addEventListener('hashchange', async () => {
    const hash = location.hash.slice(1);
    if (!hash) return;
    // #nb-{notebookHash} → Notebook wechseln
    if (hash.startsWith('nb-')) {
      const nbHash = hash.slice(3);
      const nbId = await findNotebookByHash(nbHash);
      if (nbId && nbId !== state.currentNotebookId) {
        await selectNotebook(nbId);
      }
    }
  });

  // 12. UI rendern
  renderUI();
  showStoredToast();

  // 13. P2P-Sync starten (nicht awaiten — soll im Hintergrund verbinden)
  if (state.syncEnabled) {
    startP2P().then(() => console.log('[App] P2P gestartet')).catch(e => console.error('[App] P2P Fehler:', e));
  }

  // 14. Alle Pages an Relay pushen (im Hintergrund)
  pushAllToRelay();

  // 14b. Nach dem Einspielen einer Sicherung (Neuladen): alles ans Relay und an Peers geben
  try {
    if (sessionStorage.getItem(AFTER_RESTORE_KEY)) {
      sessionStorage.removeItem(AFTER_RESTORE_KEY);
      distributeNotebooks(state.notebooks.map(nb => nb.id)).catch(() => {});
    }
  } catch {}

  // 15. P2P-Rooms für geteilte Notebooks beitreten
  joinAllSharedNotebooksP2P().catch(e => console.warn('[P2P] Shared rooms join fehlgeschlagen:', e));

  // 16. Peer-Diagnosen im Hintergrund erfassen (nur wenn Debug-Overlay da)
  startPeerDiagnosticsTimer();

  console.log('[App] Bereit.', state.notebooks.length, 'Notebooks');
}

/**
 * Kompletter Resync: Relay + P2P neu verbinden, Daten mergen, pushen.
 * Gleicher Ablauf wie beim Init (Schritte 6b, 13, 14), aber ohne Storage/UI/Canvas-Setup.
 */
let _resyncRunning = false;
async function resync() {
  if (_resyncRunning || _dataSwapRunning) return;
  _resyncRunning = true;
  console.log('[App] Resync gestartet...');
  updateSyncDebug('resync-start');
  try {
    // 1. Lokale Änderungen sofort speichern
    flushSave();

    // 1b. Live-Kanäle neu verbinden falls nötig
    reconnectLiveChannels();

    // 2. Relay: neu verbinden + Daten mergen
    try {
      const relayNodes = await initRelay(state.masterKeyHash);
      if (relayNodes) {
        await mergeRelayData(relayNodes);
        console.log('[App] Relay-Daten gemerged');
      }
    } catch (e) {
      console.warn('[App] Relay-Resync fehlgeschlagen:', e);
    }

    // 3. Aktuelle Seite neu laden (OPFS könnte durch Relay-Merge aktualisiert worden sein)
    const page = currentPage();
    if (page) await loadPage(state.currentNotebookId, page.id, page);
    redrawStrokes();
    renderUI();

    // 4. P2P: nur neu aufbauen wenn keine Peers verbunden (Signaling ist teuer + fragil)
    if (hasPeers()) {
      const payload = buildFullSyncPayload({ notebookIds: [state.currentNotebookId] });
      if (payload.notebooks.length > 0) syncSend('full-sync', payload);
      console.log('[App] P2P lebt — Full-Sync gesendet');
    } else {
      await startP2P();
    }

    // 5. Geteilte Notebooks vorsichtig nachziehen (nur Meta/Fetch, kein Stroke-Rebroadcast)
    await resyncVisibleSharedNotebooks('resync', { minIntervalMs: 10000, sendMeta: false });

    // 6. Aktuelle Page an Relay pushen
    pushAllToRelay();

    console.log('[App] Resync abgeschlossen');
    updateSyncDebug('resync-done');
  } finally {
    _resyncRunning = false;
  }
}

/**
 * Tab/Fenster wird wieder aktiv: kompletten Resync starten.
 * Mobile Browser (besonders Android Chrome) killen WebSocket + WebRTC im Hintergrund.
 * Statt einzelne Verbindungen zu prüfen: einfach alles neu aufbauen.
 */
const consoleLog = document.getElementById('console');
function handleActivityChange(event) {
  if (consoleLog) consoleLog.innerText += '\n'+event.type;
  if (!state.syncEnabled) return;
  if (document.visibilityState === 'hidden') return;
  updateSyncDebug(`wake:${event.type}`);
  reconnectLiveChannels();
  broadcastPresence().catch(() => {});
  resync();
  if (_sharedWakeTimer) clearTimeout(_sharedWakeTimer);
  _sharedWakeTimer = setTimeout(() => {
    resyncVisibleSharedNotebooks(event.type, { minIntervalMs: 5000, sendMeta: false }).catch(e => console.warn('[Share] Wake-Resync fehlgeschlagen:', e));
  }, 1500);
}

function setupEvents() {
  const container = document.getElementById('canvas-container');
  if (container) {
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointerleave', onPointerUp);
    container.addEventListener('pointercancel', onPointerUp);
  }

  window.addEventListener('resize', () => setupCanvases());
  window.addEventListener('beforeunload', () => { flushSave(); saveLocalSettings(); });
  // Vorgemerktes Leeren/Löschen festschreiben, bevor die Seite verschwindet
  window.addEventListener('pagehide', () => { commitPendingPageOp(undefined, { keepNote: true }); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') commitPendingPageOp(); });

  // Bei Tab/Fenster-Fokus: Full-Sync senden (ohne Room-Reconnect)
  document.addEventListener('visibilitychange', e => handleActivityChange(e));
  window.addEventListener('focus', e => handleActivityChange(e));
  window.addEventListener('pageshow', e => handleActivityChange(e));

  // Mobile Fallback: Erster Touch nach Inaktivität triggert Sync
  // Android Chrome feuert visibilitychange/focus nicht zuverlässig beim App-Wechsel
  let _lastSyncCheck = Date.now();
  document.addEventListener('pointerdown', e => {
    const now = Date.now();
    if (now - _lastSyncCheck > 5000 && state.syncEnabled) {
      _lastSyncCheck = now;
      handleActivityChange(e);
    }
    _lastSyncCheck = now;
  }, true);

  // Toolbar-Buttons
  document.getElementById('btn-prev')?.addEventListener('click', prevPage);
  document.getElementById('btn-next')?.addEventListener('click', nextPage);
  document.getElementById('btn-add-notebook')?.addEventListener('click', createNotebook);
  document.getElementById('btn-add-page')?.addEventListener('click', addPage);
  document.getElementById('btn-undo')?.addEventListener('click', undo);
  document.getElementById('btn-redo')?.addEventListener('click', redo);

  // Tastatur: Ctrl/Cmd+Z = Rückgängig, Ctrl/Cmd+Shift+Z bzw. Ctrl/Cmd+Y = Wiederholen
  const isTextTarget = t => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const t = e.target;
    if (isTextTarget(t) || topDialog()) return;
    const key = String(e.key || '').toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      // Läuft noch ein Hinweis „Seite geleert/gelöscht“, nimmt Strg+Z zuerst das zurück
      if (!revertPendingPageOp()) undo();
    } else if ((key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey)) {
      e.preventDefault();
      redo();
    } else if (key === 'a' && !e.shiftKey && state.tool === 'select') {
      // Auswahl-Werkzeug: alle Objekte der Seite wählen
      e.preventDefault();
      selectAllObjects();
    }
  });

  // Tastatur ohne Zusatztaste: Leertaste halten = vorübergehend bewegen,
  // P/E/S/V = Werkzeug (Stift, Radierer, Formen, Auswahl), H = Hand-Schalter, 0 = alles zeigen, Esc = Popover/Liste schließen
  let spaceHeld = false;
  const releaseSpace = () => {
    if (!spaceHeld) return;
    spaceHeld = false;
    if (state.tool === 'hand') setTool(state.lastDrawTool);
  };
  const modalOpen = () => !!document.querySelector('.modal-overlay:not(.hidden)');
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Von oben nach unten: Dialog → Popover/Menü → Notizbuch-Liste
      const dlg = topDialog();
      if (dlg) {
        if (!dlg.hasAttribute('data-persistent')) closeDialog(dlg.id);
        return;
      }
      const nbMenuOpen = !document.getElementById('nb-menu')?.hidden;
      if (nbMenuOpen || document.querySelector('[data-pop]:not([hidden])')) {
        const trigger = nbMenuOpen ? _nbMenuTrigger : null;
        closePopovers();
        if (isShown(trigger)) trigger.focus();
        return;
      }
      if (_selection || _marquee) { dropSelection(); return; }
      if (document.querySelector('.sidebar.sidebar-open')) toggleSidebar(false);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (isTextTarget(t) || modalOpen()) return;
    if (e.code === 'Space') {
      // Auf einem fokussierten Knopf behält die Leertaste ihre normale Bedeutung
      if (t && t.closest && t.closest('button, a, [role="button"]')) return;
      e.preventDefault();
      if (!e.repeat && !spaceHeld && state.tool !== 'hand' && !isDrawing) {
        spaceHeld = true;
        setTool('hand');
      }
      return;
    }
    // Auswahl: Entf/Rücktaste löscht, Pfeiltasten schieben (1 px, mit Umschalt 10 px am Bildschirm)
    if (_selection && state.tool === 'select') {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (!e.repeat) deleteSelected();
        return;
      }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const dir = arrows[e.key];
      // Auf einem fokussierten Bedienelement behalten die Pfeiltasten ihre normale Bedeutung
      if (dir && !(t && t.closest && t.closest('.popover, .toast'))) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        nudgeSelection(dir[0] * step, dir[1] * step);
        return;
      }
    }
    if (e.repeat || e.shiftKey) return;
    const key = String(e.key || '').toLowerCase();
    if (key === 'p') setTool('pen');
    else if (key === 'e') setTool('eraser');
    else if (key === 'f') setTool('fill');
    else if (key === 's') setTool('shape');
    else if (key === 'v') setTool('select');
    else if (key === 'h') toggleHand();
    else if (key === '0') fitToContent();
  });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space') releaseSpace(); });
  window.addEventListener('blur', releaseSpace);

  // Popover: Auslöser schaltet um, Tipp außerhalb oder auf einen Menüpunkt (data-close) schließt
  document.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => togglePopover(btn));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('.pop-wrap, .nb-menu, .nb-more')) closePopovers();
  }, true);
  document.querySelectorAll('[data-pop]').forEach(pop => {
    pop.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closePopovers(); });
  });

  // Farbe + Stärke (Delegation — die Knöpfe werden in renderUI() aufgebaut)
  document.getElementById('color-swatches')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.swatch');
    if (!btn) return;
    if (btn.dataset.color) { toggleColorPicker(false); setColor(btn.dataset.color); }
    else toggleColorPicker();
  });
  document.getElementById('size-options')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.size');
    if (btn) setPenSize(Number(btn.dataset.size));
  });

  // Leeren/Löschen ohne Rückfrage: sofort ausführen, Hinweis mit „Rückgängig“
  document.getElementById('btn-clear')?.addEventListener('click', clearPage);
  document.getElementById('btn-delete-page')?.addEventListener('click', deletePage);

  // Seitenübersicht: Zähler in der Seiten-Pille
  document.getElementById('btn-page-overview')?.addEventListener('click', openPageOverview);
  document.getElementById('btn-close-pages')?.addEventListener('click', () => closeDialog('pages-modal'));
  document.getElementById('btn-pages-add')?.addEventListener('click', addPage);
  document.getElementById('pages-sheet')?.addEventListener('click', onPageOverviewClick);

  // Hintergrund-Auswahl
  document.querySelectorAll('.bg-btn[data-bg]').forEach(btn => {
    btn.addEventListener('click', () => setBackground(btn.dataset.bg));
  });

  // Werkzeuge + Hand-Schalter. Nach Maus-/Touch-Klick den Fokus abgeben,
  // damit die Leertaste danach „bewegen“ bedeutet und nicht den Knopf auslöst.
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', (e) => { setTool(btn.dataset.tool); if (e.detail > 0) btn.blur(); });
  });
  document.getElementById('btn-hand')?.addEventListener('click', (e) => { toggleHand(); if (e.detail > 0) e.currentTarget.blur(); });

  // Formen: Auswahl der Form im Popover des Werkzeug-Knopfs
  document.querySelectorAll('[data-shape]').forEach(btn => {
    btn.addEventListener('click', () => setShapeType(btn.dataset.shape));
  });

  // Auswahl-Leiste: Farbe, Füllung, Duplizieren, Löschen, Umschalter „Mehrere“
  document.querySelectorAll('#selbar [data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => placeSelPopover(document.getElementById(btn.dataset.toggle)));
  });
  document.getElementById('sel-color-swatches')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.swatch[data-color]');
    if (!btn) return;
    closePopovers();
    setSelectedColor(btn.dataset.color);
  });
  document.getElementById('sel-fill-swatches')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.swatch[data-color]');
    if (!btn) return;
    closePopovers();
    setSelectedFill(btn.dataset.color);
  });
  document.getElementById('btn-sel-nofill')?.addEventListener('click', () => { closePopovers(); setSelectedFill(null); });
  document.getElementById('btn-sel-duplicate')?.addEventListener('click', (e) => { duplicateSelected(); if (e.detail > 0) e.currentTarget.blur(); });
  document.getElementById('btn-sel-delete')?.addEventListener('click', deleteSelected);
  document.getElementById('btn-sel-multi')?.addEventListener('click', (e) => { setSelMulti(!_selMulti); updateSelbar(); if (e.detail > 0) e.currentTarget.blur(); });

  // Mausrad-Zoom
  document.getElementById('canvas-container')?.addEventListener('wheel', onWheel, { passive: false });

  // Zoom-Pille: − [Alles] +  ·  „Alles“ und der Hinweis „Weiterer Inhalt“ = fitToContent
  document.getElementById('btn-fit')?.addEventListener('click', resetView);
  document.getElementById('btn-edge-hint')?.addEventListener('click', resetView);
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoomBy(1.25));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoomBy(0.8));

  // Notizbuch-Titel öffnet die Notizbuch-Liste (Schublade)
  document.getElementById('btn-notebooks')?.addEventListener('click', () => toggleSidebar());
  document.getElementById('btn-close-sidebar')?.addEventListener('click', () => toggleSidebar(false));
  document.getElementById('sidebar-overlay')?.addEventListener('click', () => toggleSidebar(false));

  // Notizbuch-Liste: Tipp auf die Zeile wechselt, „⋯“ öffnet das Menü (Maus und Touch gleich)
  document.getElementById('notebook-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('.nb');
    if (!row || e.target.closest('.rename-input')) return;
    const more = e.target.closest('.nb-more');
    if (more) { toggleNbMenu(row.dataset.nb, more); return; }
    toggleSidebar(false);
    selectNotebook(row.dataset.nb);
  });
  const nbMenu = document.getElementById('nb-menu');
  nbMenu?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...nbMenu.querySelectorAll('.menu-item:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  });
  document.getElementById('nb-menu-rename')?.addEventListener('click', () => {
    const nbId = _nbMenuFor;
    closePopovers();
    startRenameNotebook(nbId);
  });
  document.getElementById('nb-menu-share')?.addEventListener('click', async () => {
    const nbId = _nbMenuFor;
    closePopovers();
    toggleSidebar(false);
    await selectNotebook(nbId);
    openShareModal('invite');
  });
  document.getElementById('nb-menu-delete')?.addEventListener('click', () => {
    const nbId = _nbMenuFor;
    const trigger = _nbMenuTrigger;
    closePopovers();
    trigger?.focus();
    requestDeleteNotebook(nbId);
  });

  // Teilen: Einladen / Beitreten
  document.getElementById('btn-share')?.addEventListener('click', () => openShareModal('invite'));
  document.getElementById('btn-close-share')?.addEventListener('click', closeShareModal);
  document.getElementById('btn-copy-link')?.addEventListener('click', copyShareLink);
  setupTabs(document.getElementById('share-dialog'), (tab) => {
    if (tab !== 'join') { stopScanCamera(); setScanStatus(scanUi('invite'), ''); }
    // „Einladen“ wird jetzt gezeigt: Link/QR erzeugen, Notizbuch als geteilt markieren
    if (tab === 'invite' && !document.getElementById('share-link')?.value) {
      prepareShareInvite().catch(e => showToast('Einladung konnte nicht erstellt werden: ' + (e?.message || e), { fehler: true }));
    }
  });
  // Schublade: „Notizbuch beitreten“ öffnet direkt den Reiter „Beitreten“
  document.getElementById('btn-join-notebook')?.addEventListener('click', () => {
    toggleSidebar(false);
    openShareModal('join');
  });
  document.getElementById('btn-start-scan')?.addEventListener('click', () => startScanCamera('invite'));
  document.getElementById('btn-scan-image')?.addEventListener('click', () => scanImageFile('invite'));
  document.getElementById('btn-join')?.addEventListener('click', joinFromLinkField);
  document.getElementById('join-link')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); joinFromLinkField(); } });
  document.getElementById('join-link')?.addEventListener('input', () => setJoinError(''));

  // Seiten-Menü: Export der aktuellen Seite
  document.getElementById('btn-menu-export-png')?.addEventListener('click', () => exportApp('png'));
  document.getElementById('btn-menu-export-svg')?.addEventListener('click', () => exportApp('svg'));

  // Einstellungen: Zahnrad in der Schublade; Sync-Status öffnet direkt „Verbindung“
  document.getElementById('btn-settings')?.addEventListener('click', () => openSettings('general'));
  document.getElementById('status-row')?.addEventListener('click', () => openSettings('connection'));
  document.getElementById('sync-status')?.addEventListener('click', () => openSettings('connection'));
  document.getElementById('btn-close-settings')?.addEventListener('click', () => closeDialog('settings-modal'));
  setupTabs(document.getElementById('settings-sheet'), (tab) => {
    if (tab !== 'devices') { togglePairBox(false); toggleDeviceScan(false); }
    if (tab !== 'data') toggleKeyBox(false);
  });
  // Allgemein
  document.getElementById('theme-seg')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-choice]');
    if (!btn) return;
    const choice = await setTheme(btn.dataset.choice);
    document.querySelectorAll('#theme-seg [data-choice]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.choice === choice)));
  });
  document.getElementById('set-pen-only')?.addEventListener('change', (e) => setPenOnlyMode(e.currentTarget.checked));
  // Geräte
  document.getElementById('btn-pair-toggle')?.addEventListener('click', () => togglePairBox());
  document.getElementById('btn-copy-sync-link')?.addEventListener('click', (e) => copyText(deviceSyncUrl(), e.currentTarget));
  document.getElementById('btn-device-scan')?.addEventListener('click', () => toggleDeviceScan());
  document.getElementById('btn-device-scan-image')?.addEventListener('click', () => scanImageFile('device'));
  // Verbindung
  document.getElementById('set-diag')?.addEventListener('change', (e) => setSyncDebug(e.currentTarget.checked));
  document.getElementById('btn-save-connection')?.addEventListener('click', saveConnectionSettings);
  document.getElementById('btn-relay-default')?.addEventListener('click', restoreDefaultRelay);
  document.getElementById('conn-relay-url')?.addEventListener('input', () => setRelayError(''));
  // Daten & Schlüssel
  document.getElementById('btn-key-download')?.addEventListener('click', () => { if (masterKeyRaw) downloadKeyFile(masterKeyRaw); });
  document.getElementById('btn-key-copy')?.addEventListener('click', (e) => { if (masterKeyRaw) copyText(keyHex(masterKeyRaw), e.currentTarget, 'Schlüssel'); });
  document.getElementById('btn-key-show')?.addEventListener('click', () => toggleKeyBox());
  document.getElementById('btn-export-enc')?.addEventListener('click', exportBackup);
  document.getElementById('btn-import')?.addEventListener('click', importBackup);

  // Sync-Status in Leiste und Schublade aktuell halten (Relay/Peers ändern sich ohne renderUI)
  setInterval(updateSyncStatus, 3000);
  window.addEventListener('online', updateSyncStatus);
  window.addEventListener('offline', updateSyncStatus);
  applySyncDebugVisibility();

  // Zen-Mode
  document.getElementById('btn-zen')?.addEventListener('click', toggleZenMode);
  // Escape beendet Zen-Mode
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && state.zenMode) {
      state.zenMode = false;
      document.body.classList.remove('zen-mode');
      setTimeout(() => setupCanvases(), 100);
    }
  });
}

// ─── Boot ───────────────────────────────────────────────────────────────────

init().catch(err => {
  console.error('[App] Init fehlgeschlagen:', err);
});
