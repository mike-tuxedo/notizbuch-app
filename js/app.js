// app.js — Notizbuch Hauptlogik
// State-Management, Init, Canvas-Steuerung, Input-Handling, Navigation.
// Importiert Module für Storage, Canvas-Engine, P2P, Encryption.

import { initStorage, savePageData, loadPageData, deletePageData, deleteNotebookData, saveMeta, loadMeta, clearAll } from './storage.js';
import { roundPoints, drawStrokeToCanvas, drawBackground } from './canvas.js';
import { initP2P, send as p2pSend, leaveRoom } from './p2p-sync.js';
import { deriveKeyFromPassphrase, exportKey } from './encryption.js';

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
let roomKey = '';

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
 * Strokes einer Seite als JSON-Uint8Array serialisieren (für Storage).
 * @param {Array} strokes
 * @returns {Uint8Array}
 */
function serializeStrokes(strokes) {
  const json = JSON.stringify(strokes.map(s => ({
    id: s.id,
    points: roundPoints(s.points || []),
    color: s.color,
    size: s.size,
    tool: s.tool || 'pen'
  })));
  return new TextEncoder().encode(json);
}

/**
 * Uint8Array zurück zu Stroke-Array deserialisieren.
 * @param {Uint8Array} data
 * @returns {Array}
 */
function deserializeStrokes(data) {
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    return [];
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
  const data = serializeStrokes(page.strokes || []);
  await savePageData(nbId, String(page.id), data);
}

/**
 * Seite laden und Strokes in Memory setzen.
 * @param {string} notebookId
 * @param {string} pageId
 * @param {{id: string, strokes: Array}} page - Page-Objekt (wird mutiert)
 */
async function loadPage(notebookId, pageId, page) {
  const data = await loadPageData(notebookId, pageId);
  page.strokes = data ? deserializeStrokes(data) : [];
}

// ─── Meta Persistence ───────────────────────────────────────────────────────

/** App-Metadaten speichern (Notebook-Struktur ohne Strokes). */
async function saveAppMeta() {
  const meta = {
    notebooks: state.notebooks.map(nb => ({
      id: nb.id,
      name: nb.name,
      pages: nb.pages.map(p => ({ id: p.id, background: p.background || 'grid', order: p.order ?? 0 }))
    }))
  };
  await saveMeta(meta);
}

/** App-Metadaten laden und Notebooks wiederherstellen. */
async function loadAppMeta() {
  const meta = await loadMeta();
  if (!meta?.notebooks?.length) return;
  state.notebooks = meta.notebooks.map(nb => ({
    id: nb.id,
    name: nb.name,
    pages: (nb.pages || []).map(p => ({
      id: p.id, strokes: [], background: p.background || 'grid', order: p.order ?? 0
    }))
  }));
}

// ─── Canvas Management ──────────────────────────────────────────────────────

/** Canvas-Größen an Container anpassen. */
function setupCanvases() {
  const container = document.getElementById('canvas-container');
  if (!container) return;
  const w = container.clientWidth;
  const h = container.clientHeight;

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

/** Hintergrund auf bgCanvas zeichnen. */
function redrawBackground() {
  if (!bgCtx || !bgCanvas) return;
  const w = bgCanvas.width / DPR;
  const h = bgCanvas.height / DPR;
  const bg = currentPage()?.background || 'grid';
  drawBackground(bgCtx, w, h, bg, state.viewX, state.viewY, state.viewScale);
}

/**
 * Alle Strokes auf staticCanvas + Bitmap-Cache neu zeichnen.
 * Wird bei Seitenwechsel, Undo, Clear, Sync aufgerufen.
 */
function redrawStrokes() {
  if (!staticCanvas) return;
  const w = staticCanvas.width;
  const h = staticCanvas.height;

  // Bitmap-Cache erstellen/aktualisieren
  if (!strokeCacheCanvas || strokeCacheCanvas.width !== w || strokeCacheCanvas.height !== h) {
    strokeCacheCanvas = document.createElement('canvas');
    strokeCacheCanvas.width = w;
    strokeCacheCanvas.height = h;
  }

  const cacheCtx = strokeCacheCanvas.getContext('2d');
  cacheCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  cacheCtx.clearRect(0, 0, w, h);

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

  // Auf sichtbares Canvas kopieren
  const ctx = staticCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(strokeCacheCanvas, 0, 0);
}

/**
 * Bitmap-Cache auf staticCanvas compositen (für Pan/Zoom ohne Full-Redraw).
 */
function compositeStrokes() {
  if (!staticCanvas || !strokeCacheCanvas) { redrawStrokes(); return; }
  const w = staticCanvas.width;
  const h = staticCanvas.height;
  const ctx = staticCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Offset berechnen: Differenz zwischen aktuellem View und Cache-View
  const dx = (state.viewX - cacheViewX) * DPR;
  const dy = (state.viewY - cacheViewY) * DPR;
  const ds = state.viewScale / cacheViewScale;

  ctx.setTransform(ds, 0, 0, ds, dx, dy);
  ctx.drawImage(strokeCacheCanvas, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
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
  redrawBackground();
  redrawStrokes();
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
  redrawBackground();
  redrawStrokes();
  renderUI();
  saveLocalSettings();
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
  redrawStrokes();
  renderUI();
  saveLocalSettings();
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
  const data = serializeStrokes(strokes);
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
  redrawStrokes();
  saveCurrentPage();
  p2pSend('clear', { notebookId: state.currentNotebookId, pageId: page.id });
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

/** PBKDF2-Salt — fest pro App (kein Geheimnis, muss nur konsistent sein) */
const MASTER_SALT = new Uint8Array([78,111,116,105,122,98,117,99,104,45,118,50,45,115,97,108,116]);

/**
 * MasterKey aus Passphrase ableiten.
 * @param {string} passphrase
 * @returns {Promise<{keyHash: string, keyRaw: Uint8Array}>}
 */
async function deriveMasterKey(passphrase) {
  const key = await deriveKeyFromPassphrase(passphrase, MASTER_SALT);
  const raw = await exportKey(key);
  // Hash für Room-ID (erste 16 bytes als Hex)
  const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const keyHash = Array.from(hashBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { keyHash, keyRaw: new Uint8Array(raw) };
}

/**
 * Passphrase-Dialog anzeigen und MasterKey ableiten.
 * Gibt den Key-Hash zurück (= Room-ID).
 * @returns {Promise<string>} keyHash
 */
function showPassphraseDialog() {
  return new Promise(resolve => {
    const overlay = document.getElementById('passphrase-modal');
    const input = document.getElementById('passphrase-input');
    const btn = document.getElementById('passphrase-ok');
    const error = document.getElementById('passphrase-error');
    if (!overlay || !input || !btn) {
      // Fallback: prompt
      const p = prompt('Passphrase eingeben (leer = neues Notizbuch):') || '';
      resolve(p);
      return;
    }
    overlay.classList.remove('hidden');
    input.value = '';
    input.focus();
    error.textContent = '';

    const submit = async () => {
      const passphrase = input.value.trim();
      if (!passphrase) {
        error.textContent = 'Bitte Passphrase eingeben';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Ableiten...';
      try {
        const { keyHash, keyRaw } = await deriveMasterKey(passphrase);
        masterKeyRaw = keyRaw;
        state.masterKeyHash = keyHash;
        localStorage.setItem('notizbuch:masterKeyHash', keyHash);
        localStorage.setItem('notizbuch:masterKeyRaw', JSON.stringify(Array.from(keyRaw)));
        overlay.classList.add('hidden');
        resolve(keyHash);
      } catch (e) {
        error.textContent = 'Fehler: ' + e.message;
        btn.disabled = false;
        btn.textContent = 'Verbinden';
      }
    };

    btn.onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  });
}

/**
 * Gespeicherten MasterKey laden oder Passphrase-Dialog zeigen.
 * @returns {Promise<string>} roomKey (= masterKeyHash)
 */
async function initMasterKey() {
  // Gespeicherten Key prüfen
  const savedHash = localStorage.getItem('notizbuch:masterKeyHash');
  const savedRaw = localStorage.getItem('notizbuch:masterKeyRaw');
  if (savedHash && savedRaw) {
    try {
      masterKeyRaw = new Uint8Array(JSON.parse(savedRaw));
      state.masterKeyHash = savedHash;
      return savedHash;
    } catch {}
  }
  // Kein gespeicherter Key → Dialog
  return showPassphraseDialog();
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
            strokes: rp.strokes || []
          });
        } else {
          // Strokes Union-Merge by ID
          const existing = new Map(localPage.strokes.map(s => [s.id, s]));
          for (const s of (rp.strokes || [])) {
            if (!existing.has(s.id)) existing.set(s.id, s);
          }
          localPage.strokes = [...existing.values()].sort((a, b) => Number(a.id) - Number(b.id));
        }
      }
      localNb.pages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
  }

  // Sortieren und persistieren
  state.notebooks.sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
  await saveAppMeta();
  // Alle Pages speichern
  for (const nb of state.notebooks) {
    for (const p of nb.pages) {
      if (p.strokes?.length > 0) {
        await savePageData(nb.id, p.id, serializeStrokes(p.strokes));
      }
    }
  }
}

/** P2P-Room beitreten und alle Callbacks verdrahten. */
async function startP2P() {
  await initP2P(roomKey, {
    onStroke({ notebookId, pageId, stroke }, peerId) {
      const nb = state.notebooks.find(n => n.id === notebookId);
      if (!nb) return;
      const page = nb.pages.find(p => p.id === pageId);
      if (!page) return;
      if (page.strokes.some(s => s.id === stroke.id)) return;
      page.strokes.push(stroke);
      if (notebookId === state.currentNotebookId && pageId === currentPage()?.id && staticCtx) {
        staticCtx.save();
        staticCtx.translate(state.viewX, state.viewY);
        staticCtx.scale(state.viewScale, state.viewScale);
        drawStrokeToCanvas(staticCtx, stroke);
        staticCtx.restore();
        if (strokeCacheCanvas) {
          const cCtx = strokeCacheCanvas.getContext('2d');
          cCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
          cCtx.save();
          cCtx.translate(cacheViewX, cacheViewY);
          cCtx.scale(cacheViewScale, cacheViewScale);
          drawStrokeToCanvas(cCtx, stroke);
          cCtx.restore();
        }
      }
      saveCurrentPage();
    },

    onUndo({ notebookId, pageId }, peerId) {
      const nb = state.notebooks.find(n => n.id === notebookId);
      const page = nb?.pages.find(p => p.id === pageId);
      if (!page || !page.strokes.length) return;
      page.strokes.pop();
      if (notebookId === state.currentNotebookId && pageId === currentPage()?.id) redrawStrokes();
      saveCurrentPage();
    },

    onClear({ notebookId, pageId }, peerId) {
      const nb = state.notebooks.find(n => n.id === notebookId);
      const page = nb?.pages.find(p => p.id === pageId);
      if (!page) return;
      page.strokes = [];
      if (notebookId === state.currentNotebookId && pageId === currentPage()?.id) redrawStrokes();
      saveCurrentPage();
    },

    onFullSync(payload, peerId) {
      console.log('[P2P] Full-Sync von', peerId, ':', payload.notebooks?.length, 'Notebooks');
      applyFullSync(payload).then(() => {
        // Aktuelle Seite neu laden falls sich Daten geändert haben
        if (currentPage()) {
          loadPage(state.currentNotebookId, currentPage().id, currentPage()).then(() => {
            redrawStrokes();
            renderUI();
          });
        } else {
          renderUI();
        }
      });
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
      deletePageData(notebookId, pageId);
      saveAppMeta();
      if (notebookId === state.currentNotebookId) { redrawStrokes(); renderUI(); }
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
function resetView() {
  state.viewX = 0;
  state.viewY = 0;
  state.viewScale = 1;
  redrawBackground();
  redrawStrokes();
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

/** Share-Modal öffnen mit aktuellem Room-Link. */
async function openShareModal() {
  const modal = document.getElementById('share-modal');
  if (!modal) return;
  // Bei localhost: LAN-IP verwenden, damit andere Geräte den Link öffnen können
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
  const url = `${origin}${location.pathname}#${roomKey}`;
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
  await settingsPut(roomKey + ':currentNotebookId', state.currentNotebookId);
  await settingsPut(roomKey + ':pagePositions', { ...state.currentPages });
  await settingsPut(roomKey + ':color', state.color);
  await settingsPut(roomKey + ':penSizeIndex', state.penSizeIndex);
  await settingsPut(roomKey + ':customColors', [...state.customColors]);
  await settingsPut(roomKey + ':penDetected', state.penDetected);
}

async function loadLocalSettings() {
  const savedCurrentId = await settingsGet(roomKey + ':currentNotebookId');
  const savedColor = await settingsGet(roomKey + ':color');
  if (savedColor) state.color = savedColor;
  const savedPenSizeIndex = await settingsGet(roomKey + ':penSizeIndex');
  if (typeof savedPenSizeIndex === 'number') state.penSizeIndex = savedPenSizeIndex;
  const savedCustomColors = await settingsGet(roomKey + ':customColors');
  if (Array.isArray(savedCustomColors)) state.customColors = savedCustomColors;
  const savedPenDetected = await settingsGet(roomKey + ':penDetected');
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

  // Touch bei aktivem Stift: nur Pinch/Swipe erlauben
  if (state.penDetected && e.pointerType === 'touch') {
    // Pinch-Zoom tracken
    pinchState.touches[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (Object.keys(pinchState.touches).length === 2) {
      _startPinch();
    } else if (Object.keys(pinchState.touches).length === 1) {
      // Swipe starten
      swipeState.active = true;
      swipeState.pointerId = e.pointerId;
      swipeState.startX = e.clientX;
      swipeState.startY = e.clientY;
      swipeState.startTime = Date.now();
      swipeState.currentX = e.clientX;
    }
    return;
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

  // Inkrementell auf staticCanvas + Cache zeichnen
  if (staticCtx) {
    staticCtx.save();
    staticCtx.translate(state.viewX, state.viewY);
    staticCtx.scale(state.viewScale, state.viewScale);
    drawStrokeToCanvas(staticCtx, newStroke);
    staticCtx.restore();
  }
  if (strokeCacheCanvas) {
    const cCtx = strokeCacheCanvas.getContext('2d');
    cCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cCtx.save();
    cCtx.translate(cacheViewX, cacheViewY);
    cCtx.scale(cacheViewScale, cacheViewScale);
    drawStrokeToCanvas(cCtx, newStroke);
    cCtx.restore();
  }

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

  // Notebook-Name in Toolbar
  const titleEl = document.getElementById('notebook-title');
  if (titleEl) titleEl.textContent = currentNotebook()?.name || '';

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

  // 3. MasterKey → Room-Key ableiten
  roomKey = await initMasterKey();
  window.location.hash = roomKey;

  // 4. Lokale Settings laden
  const savedCurrentId = await loadLocalSettings();

  // 5. App-Metadaten laden
  await loadAppMeta();

  // 6. Wenn keine Notebooks: Default erstellen
  if (state.notebooks.length === 0) {
    createDefaultNotebook();
    await saveAppMeta();
  }

  // 7. Nav-State wiederherstellen
  if (savedCurrentId && state.notebooks.find(n => n.id === savedCurrentId)) {
    state.currentNotebookId = savedCurrentId;
    const pagePositions = await settingsGet(roomKey + ':pagePositions') || {};
    for (const nb of state.notebooks) {
      state.currentPages[nb.id] = pagePositions[nb.id] ?? 0;
    }
  } else {
    state.currentNotebookId = state.notebooks[0].id;
  }
  for (const nb of state.notebooks) {
    if (!(nb.id in state.currentPages)) state.currentPages[nb.id] = 0;
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
  requestAnimationFrame(() => setupCanvases());

  // 11. Event-Listener
  setupEvents();

  // 12. UI rendern
  renderUI();

  // 13. P2P-Sync starten (nicht awaiten — soll im Hintergrund verbinden)
  if (state.syncEnabled) {
    startP2P().then(() => console.log('[App] P2P gestartet')).catch(e => console.error('[App] P2P Fehler:', e));
  }

  console.log('[App] Bereit.', state.notebooks.length, 'Notebooks');
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

  // Toolbar-Buttons
  document.getElementById('btn-prev')?.addEventListener('click', prevPage);
  document.getElementById('btn-next')?.addEventListener('click', nextPage);
  document.getElementById('btn-add-notebook')?.addEventListener('click', createNotebook);
  document.getElementById('btn-add-testbook')?.addEventListener('click', createTestNotebook);
  document.getElementById('btn-undo')?.addEventListener('click', undo);
  document.getElementById('btn-clear')?.addEventListener('click', () => {
    if (confirm('Seite wirklich leeren?')) clearPage();
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
