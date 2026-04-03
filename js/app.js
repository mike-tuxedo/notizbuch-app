// app.js — Notizbuch Hauptlogik
// State-Management, Init, Canvas-Steuerung, Input-Handling, Navigation.
// Importiert Module für Storage, Canvas-Engine, P2P, Encryption.

import { initStorage, savePageData, loadPageData, deletePageData, deleteNotebookData, saveMeta, loadMeta, clearAll } from './storage.js';
import { roundPoints, drawStrokeToCanvas, drawBackground } from './canvas.js';
import { initP2P, send as p2pSend, leaveRoom, isConnected, hasPeers } from './p2p-sync.js';
import { generateKey, exportKey, importKey, encrypt, decrypt } from './encryption.js';
import { exportAppBundle, importAppBundle } from './share.js';
import { initRelay, putBlob as relayPut, deleteBlob as relayDelete, isRelayConnected } from './relay.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** @type {number} DPR gekappt auf 2 für Performance */
const DPR = Math.min(window.devicePixelRatio || 1, 2);

/** @type {Array<string>} Standard-Farbpalette */
const COLORS = ['#363636', '#ffffff', '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#748ffc', '#da77f2'];

/** @type {Array<{name: string, size: number}>} Stiftgrößen */
const PEN_SIZES = [
  { name: 'XS', size: 1 },
  { name: 'S', size: 2 },
  { name: 'M', size: 4 },
  { name: 'L', size: 8 },
  { name: 'XL', size: 16 }
];

const BACKGROUNDS = ['grid', 'lined', 'blank'];

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {Object} Globaler App-State */
const state = {
  /** @type {Array<{id: string, name: string, pages: Array}>} */
  notebooks: [],
  /** @type {string|null} */
  currentNotebookId: null,
  /** @type {Object<string, number>} notebookId → pageIndex */
  currentPages: {},

  // Tools
  tool: 'pen',        // 'pen' | 'eraser' | 'hand'
  color: '#363636',
  penSizeIndex: 2,
  customColors: [],
  penDetected: false,

  // View
  viewScale: 1,
  viewX: 0,
  viewY: 0,

  // Sync
  syncEnabled: true,
  connectedPeers: [],
  /** @type {string|null} Hex-Hash des MasterKeys — bestimmt Room-ID */
  masterKeyHash: null,
  /** @type {Object<string, CryptoKey>} notebookId → NotebookKey (für OPFS-Verschlüsselung) */
  notebookKeys: {},

  // UI
  sidebarOpen: true,
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

// ─── Swipe State ────────────────────────────────────────────────────────────

const swipeState = {
  active: false, pointerId: null,
  startX: 0, startY: 0, startTime: 0, currentX: 0
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** @returns {{id: string, name: string, pages: Array}|undefined} */
function currentNotebook() {
  return state.notebooks.find(n => n.id === state.currentNotebookId);
}

/** @returns {{id: string, strokes: Array, background: string}|undefined} */
function currentPage() {
  const nb = currentNotebook();
  const idx = state.currentPages[state.currentNotebookId] ?? 0;
  return nb?.pages?.[idx];
}

/** @returns {number} */
function currentPageIndex() {
  return state.currentPages[state.currentNotebookId] ?? 0;
}

/** @returns {number} */
function totalPages() {
  return currentNotebook()?.pages?.length || 1;
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
async function serializeStrokes(strokes, notebookId) {
  const json = JSON.stringify(strokes.map(s => ({
    id: s.id,
    points: roundPoints(s.points || []),
    color: s.color,
    size: s.size,
    tool: s.tool || 'pen'
  })));
  const plain = new TextEncoder().encode(json);
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
async function deserializeStrokes(data, notebookId) {
  try {
    const key = await getNotebookKey(notebookId);
    const plainBuf = await decrypt(key, data);
    return JSON.parse(new TextDecoder().decode(plainBuf));
  } catch {
    // Fallback: versuche als plain JSON (für Migration bestehender Daten)
    try {
      return JSON.parse(new TextDecoder().decode(data));
    } catch {
      return [];
    }
  }
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

async function _flushSave() {
  _saveTimer = null;
  const page = currentPage();
  if (!page) return;
  const nbId = state.currentNotebookId;
  const data = await serializeStrokes(page.strokes || [], nbId);
  await savePageData(nbId, String(page.id), data);
  relayPut(`p:${nbId}/${page.id}`, data);
}

/**
 * Seite laden: OPFS-Daten mit In-Memory Strokes (von P2P) mergen.
 * Union-Merge by ID — Remote-Strokes die während der Navigation ankamen bleiben erhalten.
 * @param {string} notebookId
 * @param {string} pageId
 * @param {{id: string, strokes: Array}} page - Page-Objekt (wird mutiert)
 */
async function loadPage(notebookId, pageId, page) {
  const data = await loadPageData(notebookId, pageId);
  const diskStrokes = data ? await deserializeStrokes(data, notebookId) : [];
  // Union-Merge: OPFS + In-Memory (P2P-Strokes die noch nicht gespeichert waren)
  const merged = new Map();
  for (const s of diskStrokes) merged.set(s.id, s);
  for (const s of (page.strokes || [])) merged.set(s.id, s);
  // Strokes vor clearedAt filtern (Clear wurde evtl. von anderem Peer gesetzt)
  const clearedAt = page.clearedAt || 0;
  page.strokes = [...merged.values()]
    .filter(s => Number(s.id) > clearedAt)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

// ─── Meta Persistence ───────────────────────────────────────────────────────

/** App-Metadaten speichern (Notebook-Struktur + NotebookKeys, ohne Strokes). */
async function saveAppMeta() {
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
      pages: nb.pages.map(p => ({ id: p.id, background: p.background || 'grid', order: p.order ?? 0, clearedAt: p.clearedAt || 0 }))
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
      relayPut('meta', encrypted);
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
    pages: (nb.pages || []).map(p => ({
      id: p.id, strokes: [], background: p.background || 'grid', order: p.order ?? 0, clearedAt: p.clearedAt || 0
    }))
  }));
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
}

/** Hintergrund der aktuellen Seite ändern. */
async function setBackground(bg) {
  const page = currentPage();
  if (!page || page.background === bg) return;
  page.background = bg;
  redrawBackground();
  await saveAppMeta();
  p2pSend('page-bg', { notebookId: state.currentNotebookId, pageId: page.id, background: bg });
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

  const strokes = currentPage()?.strokes || [];
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
}

// ─── Fit to Content ─────────────────────────────────────────────────────────

/**
 * Bounding-Box aller Strokes berechnen.
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
 */
function computeStrokeBounds() {
  const strokes = currentPage()?.strokes;
  if (!strokes?.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    if (s.tool === 'eraser') continue;
    for (const p of (s.points || [])) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
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
  const { scale, x, y } = computeFitView();
  state.viewScale = scale;
  state.viewX = x;
  state.viewY = y;
  clearAllCanvases();
  redrawBackground();
  redrawStrokes();
}

// ─── Navigation ─────────────────────────────────────────────────────────────

/**
 * Zu einer Seite im aktuellen Notebook navigieren.
 * @param {number} index
 */
async function goToPage(index) {
  const nb = currentNotebook();
  if (!nb || index < 0 || index >= nb.pages.length) return;
  flushSave();
  state.currentPages[state.currentNotebookId] = index;
  const page = currentPage();
  await loadPage(state.currentNotebookId, page.id, page);
  // Alle Canvas-Layer komplett leeren vor dem Neuzeichnen
  clearAllCanvases();
  redrawBackground();
  fitToContent();
  renderUI();
  saveLocalSettings();
}

/** Nächste Seite (erstellt neue wenn am Ende). */
async function nextPage() {
  const nb = currentNotebook();
  if (!nb) return;
  const idx = currentPageIndex();
  const nextIdx = idx + 1;

  if (nextIdx >= nb.pages.length) {
    // Neue Seite erstellen
    const pageId = String(Date.now());
    const bg = currentPage()?.background || 'grid';
    nb.pages.push({ id: pageId, strokes: [], background: bg, order: nextIdx });
    await saveAppMeta();
    p2pSend('page-created', { notebookId: state.currentNotebookId, page: { id: pageId, background: bg, order: nextIdx } });
  }

  await goToPage(nextIdx);
}

/** Vorherige Seite. */
async function prevPage() {
  const idx = currentPageIndex();
  if (idx > 0) await goToPage(idx - 1);
}

/** Aktuelle Seite löschen (min. 1 Seite muss bleiben). */
async function deletePage() {
  const nb = currentNotebook();
  if (!nb || nb.pages.length <= 1) return;
  const idx = currentPageIndex();
  const pageId = nb.pages[idx].id;
  flushSave();
  // Storage + Memory + Relay
  await deletePageData(state.currentNotebookId, pageId);
  relayDelete(`p:${state.currentNotebookId}/${pageId}`);
  nb.pages.splice(idx, 1);
  // Order neu nummerieren
  nb.pages.forEach((p, i) => p.order = i);
  // Index anpassen
  const newIdx = Math.min(idx, nb.pages.length - 1);
  state.currentPages[state.currentNotebookId] = newIdx;
  await saveAppMeta();
  p2pSend('page-deleted', { notebookId: state.currentNotebookId, pageId });
  await goToPage(newIdx);
}

/**
 * Notebook wechseln.
 * @param {string} nbId
 */
async function selectNotebook(nbId) {
  if (nbId === state.currentNotebookId) return;
  flushSave();
  state.currentNotebookId = nbId;
  if (!(nbId in state.currentPages)) state.currentPages[nbId] = 0;
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
  const nbId = String(Date.now());
  const pageId = String(Date.now() + 1);
  const name = 'Neues Notizbuch';
  state.notebooks.push({
    id: nbId, name,
    pages: [{ id: pageId, strokes: [], background: 'grid', order: 0 }]
  });
  state.currentPages[nbId] = 0;
  await saveAppMeta();
  p2pSend('nb-created', { id: nbId, name });
  p2pSend('page-created', { notebookId: nbId, page: { id: pageId, background: 'grid', order: 0 } });
  await selectNotebook(nbId);
}

/**
 * Notebook löschen.
 * @param {string} nbId
 */
async function deleteNotebook(nbId) {
  if (state.notebooks.length <= 1) return;
  // Relay: alle Pages des Notebooks löschen
  const nb = state.notebooks.find(n => n.id === nbId);
  if (nb) nb.pages.forEach(p => relayDelete(`p:${nbId}/${p.id}`));
  await deleteNotebookData(nbId);
  state.notebooks = state.notebooks.filter(n => n.id !== nbId);
  delete state.currentPages[nbId];
  if (state.currentNotebookId === nbId) {
    state.currentNotebookId = state.notebooks[0].id;
    state.currentPages[state.currentNotebookId] = 0;
  }
  await saveAppMeta();
  p2pSend('nb-deleted', { id: nbId });
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
  p2pSend('nb-renamed', { id: nbId, name: nb.name });
  renderUI();
}

/** Default-Notebook erstellen (erster Start). */
function createDefaultNotebook() {
  const nbId = String(Date.now());
  const pageId = String(Date.now() + 1);
  state.notebooks = [{
    id: nbId,
    name: `Notizen ${getClientName()}`,
    pages: [{ id: pageId, strokes: [], background: 'grid', order: 0 }]
  }];
  state.currentNotebookId = nbId;
  state.currentPages[nbId] = 0;
}

/** Testbuch mit 1000 Strokes erstellen. */
async function createTestNotebook() {
  const nbId = String(Date.now());
  const pageId = String(Date.now() + 1);
  const strokes = [];
  for (let i = 0; i < 1000; i++) {
    const y = 20 + (i % 50) * 30;
    const x = 20 + Math.floor(i / 50) * 40;
    const points = [];
    for (let j = 0; j < 8; j++) {
      points.push({ x: x + j * 4 + Math.random() * 2, y: y + Math.sin(j) * 10 + Math.random() * 2 });
    }
    strokes.push({ id: String(Date.now() + i + 2), points: roundPoints(points), color: '#000000', size: 2, tool: 'pen' });
  }
  state.notebooks.push({
    id: nbId,
    name: `Testbuch (${strokes.length} Strokes)`,
    pages: [{ id: pageId, strokes, background: 'grid', order: 0 }]
  });
  state.currentPages[nbId] = 0;
  await saveAppMeta();
  await selectNotebook(nbId);
  // Strokes sofort speichern
  const data = await serializeStrokes(strokes, nbId);
  await savePageData(nbId, pageId, data);
}

// ─── Undo / Clear ───────────────────────────────────────────────────────────

function undo() {
  const page = currentPage();
  if (!page || !page.strokes.length) return;
  page.strokes.pop();
  redrawStrokes();
  saveCurrentPage();
  p2pSend('undo', { notebookId: state.currentNotebookId, pageId: page.id });
}

function clearPage() {
  const page = currentPage();
  if (!page) return;
  page.strokes = [];
  page.clearedAt = Date.now();
  redrawStrokes();
  saveCurrentPage();
  p2pSend('clear', { notebookId: state.currentNotebookId, pageId: page.id, clearedAt: page.clearedAt });
}

// ─── Tool Selection ─────────────────────────────────────────────────────────

/**
 * @param {string} tool - 'pen' | 'eraser' | 'hand'
 */
function setTool(tool) {
  state.tool = tool;
  renderUI();
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

/** iro.js Color-Picker öffnen/schließen. */
function toggleColorPicker() {
  const popup = document.getElementById('color-picker-popup');
  if (!popup) return;
  const isOpen = !popup.classList.contains('hidden');
  if (isOpen) {
    popup.classList.add('hidden');
    return;
  }
  popup.classList.remove('hidden');
  const container = document.getElementById('iro-container');
  if (!container) return;
  container.innerHTML = '';
  // iro.js ist global via <script> geladen
  if (typeof iro === 'undefined') return;
  const picker = new iro.ColorPicker(container, {
    width: 180,
    color: state.color,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    layout: [
      { component: iro.ui.Wheel },
      { component: iro.ui.Slider, options: { sliderType: 'value' } }
    ]
  });
  picker.on('color:change', (c) => { state.color = c.hexString; });
  // Confirm-Button
  document.getElementById('iro-confirm')?.addEventListener('click', () => {
    addCustomColor(state.color);
    setColor(state.color);
    popup.classList.add('hidden');
  });
}

/**
 * @param {number} idx
 */
function setPenSize(idx) {
  state.penSizeIndex = idx;
  saveLocalSettings();
  renderUI();
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
  setTimeout(() => setupCanvases(), 100);
}

// ─── Notebook Rename ────────────────────────────────────────────────────────

/** Inline-Rename im Notebook-Titel starten. */
function startRename() {
  const titleEl = document.getElementById('notebook-title');
  if (!titleEl) return;
  const nb = currentNotebook();
  if (!nb) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = nb.name;
  input.className = 'rename-input';
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      await renameNotebook(nb.id, input.value);
      renderUI();
    }
    if (e.key === 'Escape') renderUI();
  });
  input.addEventListener('blur', async () => {
    await renameNotebook(nb.id, input.value);
    renderUI();
  });
  titleEl.textContent = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();
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
 * Erst-Start-Dialog: Neuen Key generieren oder bestehenden importieren.
 * @returns {Promise<string>} masterKeyHash
 */
function showFirstStartDialog() {
  return new Promise(resolve => {
    const overlay = document.getElementById('firststart-modal');
    if (!overlay) {
      // Fallback: direkt neuen Key generieren
      generateAndSaveKey().then(resolve);
      return;
    }
    overlay.classList.remove('hidden');

    document.getElementById('btn-new-start').onclick = async () => {
      overlay.classList.add('hidden');
      const hash = await generateAndSaveKey();
      showKeyDisplayDialog(masterKeyRaw).then(() => resolve(hash));
    };

    document.getElementById('btn-import-key').onclick = () => {
      overlay.classList.add('hidden');
      showKeyImportDialog().then(resolve);
    };
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

/**
 * Key-Anzeige-Dialog: Key anzeigen, Download anbieten, Bestätigung abwarten.
 * @param {Uint8Array} raw
 * @returns {Promise<void>}
 */
function showKeyDisplayDialog(raw) {
  return new Promise(resolve => {
    const overlay = document.getElementById('keydisplay-modal');
    if (!overlay) { resolve(); return; }
    overlay.classList.remove('hidden');

    const hex = Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('');
    const keyEl = document.getElementById('keydisplay-key');
    if (keyEl) keyEl.textContent = hex;

    document.getElementById('btn-download-key').onclick = () => downloadKeyFile(raw);

    document.getElementById('btn-copy-key').onclick = () => {
      navigator.clipboard.writeText(hex).then(() => {
        const btn = document.getElementById('btn-copy-key');
        if (btn) { btn.textContent = 'Kopiert!'; setTimeout(() => { btn.textContent = 'Kopieren'; }, 2000); }
      });
    };

    document.getElementById('btn-key-confirmed').onclick = () => {
      overlay.classList.add('hidden');
      resolve();
    };
  });
}

/**
 * Key-Import-Dialog: Hex-Eingabe oder Datei-Upload.
 * @returns {Promise<string>} masterKeyHash
 */
function showKeyImportDialog() {
  return new Promise(resolve => {
    const overlay = document.getElementById('keyimport-modal');
    if (!overlay) {
      // Fallback: prompt
      const hex = prompt('MasterKey (64 Hex-Zeichen) eingeben:');
      if (hex) {
        importKeyFromHex(hex).then(resolve).catch(() => generateAndSaveKey().then(resolve));
      } else {
        generateAndSaveKey().then(resolve);
      }
      return;
    }
    overlay.classList.remove('hidden');
    const input = document.getElementById('keyimport-input');
    const fileInput = document.getElementById('keyimport-file');
    const btn = document.getElementById('keyimport-ok');
    const error = document.getElementById('keyimport-error');
    if (input) input.value = '';
    if (error) error.textContent = '';

    const submit = async (hex) => {
      try {
        const hash = await importKeyFromHex(hex);
        overlay.classList.add('hidden');
        resolve(hash);
      } catch (e) {
        if (error) error.textContent = e.message;
      }
    };

    if (btn) btn.onclick = () => submit(input?.value || '');
    if (input) input.onkeydown = (e) => { if (e.key === 'Enter') submit(input.value); };

    if (fileInput) fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const text = (await file.text()).trim();
      if (input) input.value = text;
      submit(text);
    };
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
 * @returns {Promise<string>} masterKeyHash
 */
async function initMasterKey() {
  // 1. Gespeicherten Key prüfen
  const savedHash = localStorage.getItem('notizbuch:masterKeyHash');
  const savedRaw = localStorage.getItem('notizbuch:masterKeyRaw');
  if (savedHash && savedRaw) {
    try {
      masterKeyRaw = new Uint8Array(JSON.parse(savedRaw));
      state.masterKeyHash = savedHash;
      return savedHash;
    } catch {}
  }

  // 2. URL-Hash prüfen (MasterKey-Hash von anderem Gerät)
  const hash = location.hash.slice(1);
  if (hash && !hash.startsWith('nb') && hash.length === 32) {
    // Hash ist ein masterKeyHash — Key-Import nötig
    return showKeyImportDialog();
  }

  // 3. Kein gespeicherter Key, kein URL-Hash → Erst-Start
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
      let strokes = [];
      if (pageBlob instanceof Uint8Array) {
        try { strokes = await deserializeStrokes(pageBlob, nb.id); } catch {}
      }
      syncNb.pages.push({
        id: p.id, background: p.background || 'grid', order: p.order ?? 0,
        clearedAt: p.clearedAt || 0, strokes
      });
    }
    payload.notebooks.push(syncNb);
  }

  await applyFullSync(payload);
  console.log('[Relay] Daten gemerged:', payload.notebooks.length, 'Notebooks');
}

/**
 * Alle Pages an Relay pushen (nach Init, im Hintergrund).
 */
async function pushAllToRelay() {
  if (!isRelayConnected()) return;
  for (const nb of state.notebooks) {
    for (const p of nb.pages) {
      try {
        const data = await serializeStrokes(p.strokes || [], nb.id);
        relayPut(`p:${nb.id}/${p.id}`, data);
      } catch {}
    }
  }
  console.log('[Relay] Alle Pages gepusht');
}

// ─── P2P Sync Integration ───────────────────────────────────────────────────

/**
 * Kompletten App-State als Sync-Payload erstellen.
 * @returns {Object}
 */
function buildFullSyncPayload() {
  return {
    notebooks: state.notebooks.map(nb => ({
      id: nb.id,
      name: nb.name,
      pages: nb.pages.map(p => ({
        id: p.id,
        background: p.background || 'grid',
        order: p.order ?? 0,
        clearedAt: p.clearedAt || 0,
        strokes: (p.strokes || []).map(s => ({
          id: s.id, points: s.points, color: s.color, size: s.size, tool: s.tool
        }))
      }))
    }))
  };
}

/**
 * Full-Sync Payload in lokalen State mergen (Union-Merge).
 * @param {Object} payload - { notebooks: [...] }
 */
async function applyFullSync(payload) {
  if (!payload?.notebooks?.length) return;

  for (const remoteNb of payload.notebooks) {
    const localNb = state.notebooks.find(n => n.id === remoteNb.id);
    if (!localNb) {
      // Neues Notebook übernehmen
      state.notebooks.push({
        id: remoteNb.id, name: remoteNb.name,
        pages: remoteNb.pages.map(p => ({
          id: p.id, background: p.background || 'grid', order: p.order ?? 0,
          clearedAt: p.clearedAt || 0,
          strokes: p.strokes || []
        }))
      });
      if (!(remoteNb.id in state.currentPages)) state.currentPages[remoteNb.id] = 0;
    } else {
      // Bestehendes Notebook: Pages mergen
      for (const rp of remoteNb.pages) {
        const localPage = localNb.pages.find(p => p.id === rp.id);
        if (!localPage) {
          localNb.pages.push({
            id: rp.id, background: rp.background || 'grid', order: rp.order ?? 0,
            clearedAt: rp.clearedAt || 0,
            strokes: rp.strokes || []
          });
        } else {
          // clearedAt: höheren Wert übernehmen (= neuester Clear gewinnt)
          const remoteClearedAt = rp.clearedAt || 0;
          const localClearedAt = localPage.clearedAt || 0;
          const effectiveClearedAt = Math.max(remoteClearedAt, localClearedAt);
          localPage.clearedAt = effectiveClearedAt;

          // Strokes Union-Merge by ID, dann Strokes vor clearedAt entfernen
          const existing = new Map(localPage.strokes.map(s => [s.id, s]));
          for (const s of (rp.strokes || [])) {
            if (!existing.has(s.id)) existing.set(s.id, s);
          }
          localPage.strokes = [...existing.values()]
            .filter(s => Number(s.id) > effectiveClearedAt)
            .sort((a, b) => Number(a.id) - Number(b.id));
        }
      }
      localNb.pages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
  }

  // Sortieren und persistieren
  state.notebooks.sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
  await saveAppMeta();
  // Alle Pages speichern (auch leere — damit Clear-Zustand persistiert wird)
  for (const nb of state.notebooks) {
    for (const p of nb.pages) {
      await savePageData(nb.id, p.id, await serializeStrokes(p.strokes || [], nb.id));
    }
  }
}

/** P2P-Room beitreten und alle Callbacks verdrahten. */
async function startP2P() {
  await initP2P(state.masterKeyHash, {
    onStroke({ notebookId, pageId, stroke }, peerId) {
      const nb = state.notebooks.find(n => n.id === notebookId);
      if (!nb) return;
      const page = nb.pages.find(p => p.id === pageId);
      if (!page) return;
      if (page.strokes.some(s => s.id === stroke.id)) return;
      page.strokes.push(stroke);
      if (notebookId === state.currentNotebookId && pageId === currentPage()?.id) {
        redrawStrokes();
      }
      // Immer die betroffene Page speichern (nicht nur aktuelle)
      serializeStrokes(page.strokes, notebookId).then(d => savePageData(notebookId, pageId, d));
    },

    onUndo({ notebookId, pageId }, peerId) {
      const nb = state.notebooks.find(n => n.id === notebookId);
      const page = nb?.pages.find(p => p.id === pageId);
      if (!page || !page.strokes.length) return;
      page.strokes.pop();
      if (notebookId === state.currentNotebookId && pageId === currentPage()?.id) redrawStrokes();
      serializeStrokes(page.strokes, notebookId).then(d => savePageData(notebookId, pageId, d));
    },

    onClear({ notebookId, pageId, clearedAt }, peerId) {
      const nb = state.notebooks.find(n => n.id === notebookId);
      const page = nb?.pages.find(p => p.id === pageId);
      if (!page) return;
      page.strokes = [];
      page.clearedAt = clearedAt || Date.now();
      if (notebookId === state.currentNotebookId && pageId === currentPage()?.id) redrawStrokes();
      serializeStrokes(page.strokes, notebookId).then(d => savePageData(notebookId, pageId, d));
    },

    async onFullSync(payload, peerId) {
      console.log('[P2P] Full-Sync von', peerId, ':', payload.notebooks?.length, 'Notebooks');
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
            // Strokes der Duplikat-Pages in den Keeper mergen
            for (const dp of dup.pages) {
              const kp = keeper.pages.find(p => p.id === dp.id);
              if (!kp && dp.strokes?.length > 0) {
                keeper.pages.push(dp);
              } else if (kp) {
                const existing = new Map(kp.strokes.map(s => [s.id, s]));
                for (const s of (dp.strokes || [])) { if (!existing.has(s.id)) existing.set(s.id, s); }
                kp.strokes = [...existing.values()].sort((a, b) => Number(a.id) - Number(b.id));
              }
            }
            toRemove.push(dup.id);
          }
        }
        if (toRemove.length > 0) {
          for (const id of toRemove) {
            state.notebooks = state.notebooks.filter(n => n.id !== id);
            delete state.currentPages[id];
            deleteNotebookData(id);
          }
          if (!state.notebooks.find(n => n.id === state.currentNotebookId)) {
            state.currentNotebookId = state.notebooks[0]?.id;
            state.currentPages[state.currentNotebookId] = 0;
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

    onNbCreated({ id, name }, peerId) {
      if (state.notebooks.find(n => n.id === id)) return;
      state.notebooks.push({ id, name, pages: [] });
      state.currentPages[id] = 0;
      saveAppMeta();
      renderUI();
      console.log('[P2P] Notebook erstellt von Peer:', name);
    },

    onNbDeleted({ id }, peerId) {
      const delNb = state.notebooks.find(n => n.id === id);
      if (delNb) delNb.pages.forEach(p => relayDelete(`p:${id}/${p.id}`));
      state.notebooks = state.notebooks.filter(n => n.id !== id);
      delete state.currentPages[id];
      if (state.currentNotebookId === id && state.notebooks.length > 0) {
        state.currentNotebookId = state.notebooks[0].id;
        state.currentPages[state.currentNotebookId] = 0;
        const page = currentPage();
        if (page) loadPage(state.currentNotebookId, page.id, page).then(() => {
          redrawBackground(); redrawStrokes();
        });
      }
      deleteNotebookData(id);
      saveAppMeta();
      renderUI();
    },

    onNbRenamed({ id, name }, peerId) {
      const nb = state.notebooks.find(n => n.id === id);
      if (nb) nb.name = name;
      saveAppMeta();
      renderUI();
    },

    onPageCreated({ notebookId, page }, peerId) {
      const nb = state.notebooks.find(n => n.id === notebookId);
      if (!nb) return;
      if (nb.pages.find(p => p.id === page.id)) return;
      nb.pages.push({ id: page.id, strokes: [], background: page.background || 'grid', order: page.order ?? nb.pages.length });
      nb.pages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      saveAppMeta();
      renderUI();
    },

    onPageDeleted({ notebookId, pageId }, peerId) {
      const nb = state.notebooks.find(n => n.id === notebookId);
      if (!nb) return;
      nb.pages = nb.pages.filter(p => p.id !== pageId);
      nb.pages.forEach((p, i) => p.order = i);
      deletePageData(notebookId, pageId);
      relayDelete(`p:${notebookId}/${pageId}`);
      // Index anpassen falls aktive Seite betroffen
      if (notebookId in state.currentPages) {
        const idx = state.currentPages[notebookId];
        if (idx >= nb.pages.length) state.currentPages[notebookId] = Math.max(0, nb.pages.length - 1);
      }
      saveAppMeta();
      if (notebookId === state.currentNotebookId) {
        const page = currentPage();
        if (page) loadPage(notebookId, page.id, page).then(() => {
          clearAllCanvases(); redrawBackground(); redrawStrokes();
        });
        renderUI();
      }
    },

    onPageBg({ notebookId, pageId, background }, peerId) {
      const nb = state.notebooks.find(n => n.id === notebookId);
      if (!nb) return;
      const page = nb.pages.find(p => p.id === pageId);
      if (!page) return;
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
      // Full-Sync an neuen Peer senden
      const payload = buildFullSyncPayload();
      if (payload.notebooks.length > 0) {
        p2pSend('full-sync', payload, peerId);
        console.log('[P2P] Full-Sync gesendet an', peerId);
      }
    },

    onPeerLeave(peerId) {
      state.connectedPeers = state.connectedPeers.filter(id => id !== peerId);
      renderUI();
    }
  });
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

/** View auf 1:1 zurücksetzen. */
/** View zurücksetzen: Fit-to-Content oder 1:1 wenn keine Strokes. */
function resetView() {
  fitToContent();
}

// ─── Mobile Sidebar Toggle ──────────────────────────────────────────────────

/** Sidebar auf mobil ein-/ausblenden. */
function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!sidebar) return;
  const open = sidebar.classList.toggle('sidebar-open');
  overlay?.classList.toggle('active', open);
}

// ─── Share Modal ────────────────────────────────────────────────────────────

/** Share-Modal öffnen — Notebook-Invite-Link mit NotebookKey im Fragment. */
async function openShareModal() {
  const modal = document.getElementById('share-modal');
  if (!modal) return;
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
  const nb = currentNotebook();
  const nbHash = await notebookHash(nbId);
  const url = `${origin}${location.pathname}#nb-${nbHash}&k=${encodeURIComponent(keyB64)}&name=${encodeURIComponent(nb?.name || '')}`;
  const linkInput = document.getElementById('share-link');
  if (linkInput) linkInput.value = url;
  // QR-Code generieren (qrcode.js API: new QRCode(element, options))
  const qrContainer = document.getElementById('qr-container');
  if (qrContainer && typeof QRCode !== 'undefined') {
    qrContainer.innerHTML = '';
    new QRCode(qrContainer, {
      text: url, width: 200, height: 200,
      colorDark: '#1a1730', colorLight: '#fefcf8',
      correctLevel: QRCode.CorrectLevel.L
    });
  }
  modal.classList.remove('hidden');
}

function closeShareModal() {
  document.getElementById('share-modal')?.classList.add('hidden');
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
    if (!notebookId) notebookId = String(Date.now());
  }

  // NotebookKey speichern
  state.notebookKeys[notebookId] = invite.key;
  const raw = await exportKey(invite.key);
  localStorage.setItem(`notizbuch:nbKey:${notebookId}`, JSON.stringify(Array.from(raw)));

  // Notebook erstellen wenn nicht vorhanden
  if (!state.notebooks.find(n => n.id === notebookId)) {
    const pageId = String(Date.now() + 1);
    state.notebooks.push({
      id: notebookId, name: invite.name,
      pages: [{ id: pageId, strokes: [], background: 'grid', order: 0 }]
    });
    state.currentPages[notebookId] = 0;
    await saveAppMeta();
  }

  // Zum geteilten Notebook wechseln
  await selectNotebook(notebookId);

  // URL-Fragment auf Notebook-Hash setzen
  await updateUrlHash();
  console.log('[Share] Invite verarbeitet:', invite.name, notebookId);
}

// ─── Export / Import ─────────────────────────────────────────────────────────

/** Alle Keys als verschlüsseltes Bundle exportieren (.enc Datei). */
async function exportApp() {
  const passphrase = prompt('Passphrase für den Export:');
  if (!passphrase?.trim()) return;
  try {
    const masterKey = await getMasterCryptoKey();
    if (!masterKey) { alert('Kein MasterKey vorhanden.'); return; }
    const bundle = await exportAppBundle(masterKey, state.notebookKeys, passphrase);
    // Download triggern
    const blob = new Blob([bundle], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: 'notizbuch-backup.enc' });
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Export fehlgeschlagen: ' + e.message);
  }
}

/** Verschlüsseltes Bundle importieren — alle Keys installieren. */
async function importApp() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.enc';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const passphrase = prompt('Passphrase für den Import:');
    if (!passphrase?.trim()) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { masterKey, notebookKeyMap } = await importAppBundle(bytes, passphrase);
      // MasterKey installieren
      const rawMaster = new Uint8Array(await exportKey(masterKey));
      const hash = await computeKeyHash(rawMaster);
      saveMasterKeyToStorage(rawMaster, hash);
      // NotebookKeys installieren
      for (const [id, key] of Object.entries(notebookKeyMap)) {
        state.notebookKeys[id] = key;
        const raw = await exportKey(key);
        localStorage.setItem(`notizbuch:nbKey:${id}`, JSON.stringify(Array.from(raw)));
      }
      alert('Import erfolgreich! App wird neu geladen.');
      location.reload();
    } catch (e) {
      alert('Import fehlgeschlagen — falsche Passphrase? ' + e.message);
    }
  };
  input.click();
}

function copyShareLink() {
  const link = document.getElementById('share-link')?.value;
  if (!link) return;
  navigator.clipboard.writeText(link).then(() => {
    const btn = document.getElementById('btn-copy-link');
    if (btn) { btn.textContent = 'Kopiert!'; setTimeout(() => { btn.textContent = 'Kopieren'; }, 2000); }
  });
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
  await settingsPut(state.masterKeyHash + ':pagePositions', { ...state.currentPages });
  await settingsPut(state.masterKeyHash + ':color', state.color);
  await settingsPut(state.masterKeyHash + ':penSizeIndex', state.penSizeIndex);
  await settingsPut(state.masterKeyHash + ':customColors', [...state.customColors]);
  await settingsPut(state.masterKeyHash + ':penDetected', state.penDetected);
}

async function loadLocalSettings() {
  const savedCurrentId = await settingsGet(state.masterKeyHash + ':currentNotebookId');
  const savedColor = await settingsGet(state.masterKeyHash + ':color');
  if (savedColor) state.color = savedColor;
  const savedPenSizeIndex = await settingsGet(state.masterKeyHash + ':penSizeIndex');
  if (typeof savedPenSizeIndex === 'number') state.penSizeIndex = savedPenSizeIndex;
  const savedCustomColors = await settingsGet(state.masterKeyHash + ':customColors');
  if (Array.isArray(savedCustomColors)) state.customColors = savedCustomColors;
  const savedPenDetected = await settingsGet(state.masterKeyHash + ':penDetected');
  if (typeof savedPenDetected === 'boolean') state.penDetected = savedPenDetected;
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

let isPanning = false;
let panStartX = 0, panStartY = 0;
let panStartViewX = 0, panStartViewY = 0;
let panPointerId = null;

function onPointerDown(e) {
  // Palm-Rejection: Pen erkannt → Touch ignorieren für Zeichnen
  if (e.pointerType === 'pen') {
    state.penDetected = true;
  }

  // Touch-Handling: Bei Pen-Erkennung oder wenn nicht Hand-Tool → Touch ignorieren für Zeichnen
  if (e.pointerType === 'touch') {
    if (state.tool === 'hand') {
      // Hand-Tool: Touch erlaubt für Pan/Pinch/Swipe
      pinchState.touches[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (Object.keys(pinchState.touches).length === 2) {
        _startPinch();
      } else if (Object.keys(pinchState.touches).length === 1) {
        // Single-Touch: Pan starten
        isPanning = true;
        panPointerId = e.pointerId;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panStartViewX = state.viewX;
        panStartViewY = state.viewY;
        // Gleichzeitig Swipe tracken
        swipeState.active = true;
        swipeState.pointerId = e.pointerId;
        swipeState.startX = e.clientX;
        swipeState.startY = e.clientY;
        swipeState.startTime = Date.now();
        swipeState.currentX = e.clientX;
      }
      return;
    }
    // Pen erkannt → Touch komplett ignorieren (Palm-Rejection)
    if (state.penDetected) return;
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

  isDrawing = true;
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
  // Pinch-Zoom
  if (pinchState.touches[e.pointerId]) {
    pinchState.touches[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (pinchState.active) _updatePinch();
    // Swipe-Tracking
    if (swipeState.active && e.pointerId === swipeState.pointerId) {
      swipeState.currentX = e.clientX;
    }
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

  if (!isDrawing || e.pointerId !== activePointerId) return;
  e.preventDefault();

  const pos = getCanvasPos(e);
  const world = screenToWorld(pos.x, pos.y);
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
  // Pinch-Zoom beenden
  if (pinchState.touches[e.pointerId]) {
    delete pinchState.touches[e.pointerId];
    if (pinchState.active) {
      pinchState.active = false;
      redrawStrokes(); // Cache nach Zoom aktualisieren
    }
    // Swipe auswerten
    if (swipeState.active && e.pointerId === swipeState.pointerId) {
      swipeState.active = false;
      const dx = swipeState.currentX - swipeState.startX;
      const dt = Date.now() - swipeState.startTime;
      if (Math.abs(dx) > 80 && dt < 800) {
        if (dx > 0) prevPage();
        else nextPage();
      }
    }
    return;
  }

  // Panning beenden
  if (isPanning && e.pointerId === panPointerId) {
    isPanning = false;
    panPointerId = null;
    redrawStrokes(); // Cache aktualisieren
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
  if (!page || currentPoints.length < 2) { currentPoints = []; lastPoint = null; return; }

  const strokeId = String(Date.now());
  const newStroke = {
    id: strokeId,
    points: roundPoints(currentPoints),
    color: state.color,
    size: PEN_SIZES[state.penSizeIndex].size,
    tool: state.tool === 'eraser' ? 'eraser' : 'pen'
  };

  page.strokes.push(newStroke);
  redrawStrokes();

  saveCurrentPage();
  p2pSend('stroke', { notebookId: state.currentNotebookId, pageId: page.id, stroke: newStroke });
  currentPoints = [];
  lastPoint = null;
}

// ─── UI Rendering ───────────────────────────────────────────────────────────

/** Sidebar + Toolbar + Page-Bar aktualisieren. */
function renderUI() {
  // Notebook-Liste in Sidebar
  const nbList = document.getElementById('notebook-list');
  if (nbList) {
    nbList.innerHTML = state.notebooks.map(nb => `
      <button class="notebook-tab ${nb.id === state.currentNotebookId ? 'active' : ''}" data-nb="${nb.id}">
        <span class="nb-name">${nb.name}</span>
        ${state.notebooks.length > 1 ? `<button class="nb-delete" data-delete="${nb.id}" title="Löschen">&times;</button>` : ''}
      </button>
    `).join('');

    // Event-Listener
    nbList.querySelectorAll('.notebook-tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        if (e.target.classList.contains('nb-delete')) return;
        selectNotebook(btn.dataset.nb);
      });
    });
    nbList.querySelectorAll('.nb-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Notebook löschen?')) deleteNotebook(btn.dataset.delete);
      });
    });
  }

  // Notebook-Name in Toolbar + Pagebar (mobil)
  const nbName = currentNotebook()?.name || '';
  const titleEl = document.getElementById('notebook-title');
  if (titleEl) titleEl.textContent = nbName;
  const pagebarTitle = document.getElementById('pagebar-title');
  if (pagebarTitle) pagebarTitle.textContent = nbName;

  // Page-Indicator
  const pageIndicator = document.getElementById('page-indicator');
  if (pageIndicator) {
    pageIndicator.textContent = `${currentPageIndex() + 1} / ${totalPages()}`;
  }

  // Prev/Next Buttons
  const prevBtn = document.getElementById('btn-prev');
  const nextBtn = document.getElementById('btn-next');
  if (prevBtn) prevBtn.disabled = currentPageIndex() === 0;
  if (nextBtn) nextBtn.disabled = false; // Immer erlaubt (erstellt neue Seite)

  // Delete-Page Button (nur wenn >1 Seite)
  const delPageBtn = document.getElementById('btn-delete-page');
  if (delPageBtn) delPageBtn.disabled = totalPages() <= 1;

  // Hintergrund-Buttons
  const curBg = currentPage()?.background || 'grid';
  document.querySelectorAll('.bg-btn[data-bg]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.bg === curBg);
  });

  // Tool-Buttons
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === state.tool);
  });

  // Canvas-Cursor
  const container = document.getElementById('canvas-container');
  if (container) {
    container.classList.toggle('hand-cursor', state.tool === 'hand');
    if (state.tool !== 'hand') container.style.cursor = state.tool === 'eraser' ? 'cell' : 'crosshair';
  }

  // Farb-Palette (Standard + Custom + Picker)
  const colorPalette = document.getElementById('color-palette');
  if (colorPalette) {
    const allColors = [...COLORS, ...state.customColors];
    colorPalette.innerHTML = allColors.map(c =>
      `<button class="color-dot ${c === state.color ? 'active' : ''}" data-color="${c}" style="background:${c}"></button>`
    ).join('') + `<button class="color-dot color-picker-btn" id="btn-color-picker" title="Farbwähler"></button>`;
    colorPalette.querySelectorAll('.color-dot[data-color]').forEach(btn => {
      btn.addEventListener('click', () => setColor(btn.dataset.color));
    });
    document.getElementById('btn-color-picker')?.addEventListener('click', toggleColorPicker);
  }

  // Größen-Palette
  const sizePalette = document.getElementById('size-palette');
  if (sizePalette) {
    sizePalette.innerHTML = PEN_SIZES.map((s, i) =>
      `<button class="size-btn ${i === state.penSizeIndex ? 'active' : ''}" data-size="${i}">${s.name}</button>`
    ).join('');
    sizePalette.querySelectorAll('.size-btn').forEach(btn => {
      btn.addEventListener('click', () => setPenSize(Number(btn.dataset.size)));
    });
  }

  // Mobile Farb-Trigger Dot
  const mColorDot = document.getElementById('mobile-color-dot');
  if (mColorDot) mColorDot.style.background = state.color;
  // Mobile Größen-Label
  const mSizeLabel = document.getElementById('mobile-size-label');
  if (mSizeLabel) mSizeLabel.textContent = PEN_SIZES[state.penSizeIndex].name;

  // Mobile Color Grid
  const mColorGrid = document.getElementById('mobile-color-grid');
  if (mColorGrid) {
    const allColors = [...COLORS, ...state.customColors];
    mColorGrid.innerHTML = allColors.map(c =>
      `<button class="color-dot ${c === state.color ? 'active' : ''}" data-mcolor="${c}" style="background:${c}"></button>`
    ).join('');
    mColorGrid.querySelectorAll('[data-mcolor]').forEach(btn => {
      btn.addEventListener('click', () => {
        setColor(btn.dataset.mcolor);
        document.getElementById('mobile-color-menu')?.classList.add('hidden');
      });
    });
  }

  // Mobile Size Grid
  const mSizeGrid = document.getElementById('mobile-size-grid');
  if (mSizeGrid) {
    mSizeGrid.innerHTML = PEN_SIZES.map((s, i) =>
      `<button class="size-btn ${i === state.penSizeIndex ? 'active' : ''}" data-msize="${i}">${s.name}</button>`
    ).join('');
    mSizeGrid.querySelectorAll('[data-msize]').forEach(btn => {
      btn.addEventListener('click', () => {
        setPenSize(Number(btn.dataset.msize));
        document.getElementById('mobile-size-menu')?.classList.add('hidden');
      });
    });
  }

  // Peer-Count
  const peerEl = document.getElementById('peer-count');
  if (peerEl) {
    const n = state.connectedPeers.length;
    peerEl.textContent = n > 0 ? `${n} Peer${n > 1 ? 's' : ''}` : '';
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────

async function init() {
  console.log('[App] Init...');

  // 1. Storage initialisieren
  const storageBackend = await initStorage();
  console.log('[App] Storage:', storageBackend);

  // 2. Settings-DB öffnen
  settingsDB = await openSettingsDB();

  // 3. Invite-Link prüfen (bevor MasterKey-Dialog kommt)
  const invite = await parseInviteLink();

  // 4. MasterKey laden oder generieren
  await initMasterKey();

  // 5. Lokale Settings laden
  const savedCurrentId = await loadLocalSettings();

  // 6. App-Metadaten laden (lokal)
  await loadAppMeta();

  // 6b. Relay: verschlüsselte Snapshots laden und mergen
  try {
    const relayNodes = await initRelay(state.masterKeyHash);
    if (relayNodes) await mergeRelayData(relayNodes);
  } catch (e) {
    console.warn('[Relay] Init fehlgeschlagen:', e);
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
      state.currentPages[nb.id] = pagePositions[nb.id] ?? 0;
    }
  } else {
    state.currentNotebookId = state.notebooks[0].id;
  }
  for (const nb of state.notebooks) {
    if (!(nb.id in state.currentPages)) state.currentPages[nb.id] = 0;
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

  // 13. P2P-Sync starten (nicht awaiten — soll im Hintergrund verbinden)
  if (state.syncEnabled) {
    startP2P().then(() => console.log('[App] P2P gestartet')).catch(e => console.error('[App] P2P Fehler:', e));
  }

  // 14. Alle Pages an Relay pushen (im Hintergrund)
  pushAllToRelay();

  console.log('[App] Bereit.', state.notebooks.length, 'Notebooks');
}

/**
 * Kompletter Resync: Relay + P2P neu verbinden, Daten mergen, pushen.
 * Gleicher Ablauf wie beim Init (Schritte 6b, 13, 14), aber ohne Storage/UI/Canvas-Setup.
 */
let _resyncRunning = false;
async function resync() {
  if (_resyncRunning) return;
  _resyncRunning = true;
  console.log('[App] Resync gestartet...');
  try {
    // 1. Lokale Änderungen sofort speichern
    flushSave();

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
    fitToContent();
    renderUI();

    // 4. P2P: nur neu aufbauen wenn keine Peers verbunden (Signaling ist teuer + fragil)
    if (hasPeers()) {
      const payload = buildFullSyncPayload();
      if (payload.notebooks.length > 0) p2pSend('full-sync', payload);
      console.log('[App] P2P lebt — Full-Sync gesendet');
    } else {
      await startP2P();
    }

    // 5. Alle Pages an Relay pushen
    pushAllToRelay();

    console.log('[App] Resync abgeschlossen');
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
  consoleLog.innerText += '\n'+event.type;
  if (!state.syncEnabled) return;
  if (document.visibilityState === 'hidden') return;
  resync();
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
  document.getElementById('btn-add-testbook')?.addEventListener('click', createTestNotebook);
  document.getElementById('btn-undo')?.addEventListener('click', undo);
  document.getElementById('btn-clear')?.addEventListener('click', () => {
    if (confirm('Seite wirklich leeren?')) clearPage();
  });
  document.getElementById('btn-delete-page')?.addEventListener('click', () => {
    if (confirm('Seite löschen?')) deletePage();
  });

  // Hintergrund-Auswahl
  document.querySelectorAll('.bg-btn[data-bg]').forEach(btn => {
    btn.addEventListener('click', () => setBackground(btn.dataset.bg));
  });

  // Tool-Buttons
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  // Mausrad-Zoom
  document.getElementById('canvas-container')?.addEventListener('wheel', onWheel, { passive: false });

  // View-Reset
  document.getElementById('btn-reset-view')?.addEventListener('click', resetView);

  // Sidebar-Toggle (mobil)
  document.getElementById('btn-burger')?.addEventListener('click', toggleSidebar);
  // Sidebar schließen bei Klick auf Overlay
  document.getElementById('sidebar-overlay')?.addEventListener('click', toggleSidebar);

  // Share
  document.getElementById('btn-share')?.addEventListener('click', openShareModal);
  document.getElementById('btn-export')?.addEventListener('click', exportApp);
  document.getElementById('btn-import')?.addEventListener('click', importApp);

  // Mobile Farb-/Größen-Menüs
  document.getElementById('btn-mobile-color')?.addEventListener('click', () => {
    document.getElementById('mobile-color-menu')?.classList.toggle('hidden');
    document.getElementById('mobile-size-menu')?.classList.add('hidden');
  });
  document.getElementById('btn-mobile-size')?.addEventListener('click', () => {
    document.getElementById('mobile-size-menu')?.classList.toggle('hidden');
    document.getElementById('mobile-color-menu')?.classList.add('hidden');
  });
  document.getElementById('btn-close-share')?.addEventListener('click', closeShareModal);
  document.getElementById('btn-copy-link')?.addEventListener('click', copyShareLink);

  // Color-Picker
  document.getElementById('btn-color-picker')?.addEventListener('click', toggleColorPicker);

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

  // Notebook-Title Doppelklick → Rename
  document.getElementById('notebook-title')?.addEventListener('dblclick', startRename);
}

// ─── Boot ───────────────────────────────────────────────────────────────────

init().catch(err => {
  console.error('[App] Init fehlgeschlagen:', err);
});
