// storage.js — OPFS + IndexedDB Fallback Storage
// Speichert Seiten-Daten (Strokes) und App-Metadaten.
// Primär: OPFS (Origin Private File System) — binäre Dateien pro Seite.
// Fallback: IndexedDB — wenn OPFS nicht verfügbar (z.B. Firefox Stable).

// ─── Feature Detection ─────────────────────────────────────────────────────

/** @type {'opfs'|'idb'|null} Aktiver Storage-Backend nach init() */
let backend = null;

/** @type {IDBDatabase|null} IndexedDB-Instanz (nur bei Fallback) */
let idb = null;

const IDB_NAME = 'notizbuch-storage';
const IDB_VERSION = 1;
const IDB_STORE_PAGES = 'pages';    // key: "notebookId/pageId"
const IDB_STORE_META = 'meta';      // key: "meta"

// ─── Init ───────────────────────────────────────────────────────────────────

/**
 * Storage initialisieren. Prüft OPFS-Verfügbarkeit, fällt auf IndexedDB zurück.
 * Muss einmal beim App-Start aufgerufen werden.
 * @returns {Promise<'opfs'|'idb'>} Das aktive Backend
 */
export async function initStorage() {
  if (backend) return backend;

  if (await _checkOPFS()) {
    backend = 'opfs';
    console.log('[Storage] OPFS verfügbar');
  } else {
    await _openIDB();
    backend = 'idb';
    console.log('[Storage] OPFS nicht verfügbar, nutze IndexedDB Fallback');
  }
  return backend;
}

/**
 * Gibt das aktive Backend zurück.
 * @returns {'opfs'|'idb'|null}
 */
export function getBackend() {
  return backend;
}

// ─── Page Data (Strokes) ────────────────────────────────────────────────────

/**
 * Seiten-Daten speichern (Uint8Array — verschlüsselt oder plain).
 * @param {string} notebookId
 * @param {string} pageId
 * @param {Uint8Array} data - Binärdaten der Seite
 * @returns {Promise<void>}
 */
export async function savePageData(notebookId, pageId, data) {
  if (backend === 'opfs') {
    return _opfsSavePageData(notebookId, pageId, data);
  }
  return _idbSavePageData(notebookId, pageId, data);
}

/**
 * Seiten-Daten laden.
 * @param {string} notebookId
 * @param {string} pageId
 * @returns {Promise<Uint8Array|null>} Binärdaten oder null wenn nicht vorhanden
 */
export async function loadPageData(notebookId, pageId) {
  if (backend === 'opfs') {
    return _opfsLoadPageData(notebookId, pageId);
  }
  return _idbLoadPageData(notebookId, pageId);
}

/**
 * Seiten-Daten löschen.
 * @param {string} notebookId
 * @param {string} pageId
 * @returns {Promise<void>}
 */
export async function deletePageData(notebookId, pageId) {
  if (backend === 'opfs') {
    return _opfsDeletePageData(notebookId, pageId);
  }
  return _idbDeletePageData(notebookId, pageId);
}

/**
 * Alle Seiten-Daten eines Notebooks löschen.
 * @param {string} notebookId
 * @returns {Promise<void>}
 */
export async function deleteNotebookData(notebookId) {
  if (backend === 'opfs') {
    return _opfsDeleteNotebookData(notebookId);
  }
  return _idbDeleteNotebookData(notebookId);
}

// ─── App-Metadaten ──────────────────────────────────────────────────────────

/**
 * App-Metadaten speichern (Notebook-Struktur, Page-IDs, etc.).
 * Keine sensitiven Daten — plain JSON.
 * @param {Object} meta - Metadaten-Objekt
 * @returns {Promise<void>}
 */
export async function saveMeta(meta) {
  if (backend === 'opfs') {
    return _opfsSaveMeta(meta);
  }
  return _idbSaveMeta(meta);
}

/**
 * App-Metadaten laden.
 * @returns {Promise<Object|null>} Metadaten oder null
 */
export async function loadMeta() {
  if (backend === 'opfs') {
    return _opfsLoadMeta();
  }
  return _idbLoadMeta();
}

// ─── Alles löschen ──────────────────────────────────────────────────────────

/**
 * Alle gespeicherten Daten löschen (Pages + Meta).
 * @returns {Promise<void>}
 */
export async function clearAll() {
  if (backend === 'opfs') {
    return _opfsClearAll();
  }
  return _idbClearAll();
}

// ═══════════════════════════════════════════════════════════════════════════
// OPFS Implementation
// Dateipfade: /notebooks/{notebookId}/pages/{pageId}.bin
//             /meta.json
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Prüft ob OPFS verfügbar und nutzbar ist.
 * Firefox Stable wirft SecurityError bei getDirectory().
 * @returns {Promise<boolean>}
 */
async function _checkOPFS() {
  try {
    if (!('storage' in navigator && 'getDirectory' in navigator.storage)) return false;
    const root = await navigator.storage.getDirectory();
    // Schreibtest: Datei erstellen und sofort löschen
    const testName = '_opfs_test_' + Date.now();
    const fh = await root.getFileHandle(testName, { create: true });
    await root.removeEntry(testName);
    return true;
  } catch {
    return false;
  }
}

/**
 * OPFS-Verzeichnis traversieren/erstellen.
 * @param {...string} parts - Pfad-Teile
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function _opfsDir(...parts) {
  let dir = await navigator.storage.getDirectory();
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

/**
 * @param {string} notebookId
 * @param {string} pageId
 * @param {Uint8Array} data
 */
async function _opfsSavePageData(notebookId, pageId, data) {
  const dir = await _opfsDir('notebooks', notebookId, 'pages');
  const fh = await dir.getFileHandle(`${pageId}.bin`, { create: true });
  const writable = await fh.createWritable();
  await writable.write(data);
  await writable.close();
}

/**
 * @param {string} notebookId
 * @param {string} pageId
 * @returns {Promise<Uint8Array|null>}
 */
async function _opfsLoadPageData(notebookId, pageId) {
  try {
    const dir = await _opfsDir('notebooks', notebookId, 'pages');
    const fh = await dir.getFileHandle(`${pageId}.bin`);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * @param {string} notebookId
 * @param {string} pageId
 */
async function _opfsDeletePageData(notebookId, pageId) {
  try {
    const dir = await _opfsDir('notebooks', notebookId, 'pages');
    await dir.removeEntry(`${pageId}.bin`);
  } catch { /* Datei existiert nicht — ok */ }
}

/** @param {string} notebookId */
async function _opfsDeleteNotebookData(notebookId) {
  try {
    const nbDir = await _opfsDir('notebooks');
    await nbDir.removeEntry(notebookId, { recursive: true });
  } catch { /* Verzeichnis existiert nicht — ok */ }
}

/** @param {Object} meta */
/** @param {Object|Uint8Array} meta */
async function _opfsSaveMeta(meta) {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle('meta.bin', { create: true });
  const writable = await fh.createWritable();
  // Uint8Array (verschlüsselt) oder Object (plain JSON)
  const data = meta instanceof Uint8Array ? meta : new TextEncoder().encode(JSON.stringify(meta));
  await writable.write(data);
  await writable.close();
}

/** @returns {Promise<Uint8Array|Object|null>} */
async function _opfsLoadMeta() {
  try {
    const root = await navigator.storage.getDirectory();
    // Versuche zuerst verschlüsselte meta.bin, dann plain meta.json (Migration)
    let file;
    try {
      const fh = await root.getFileHandle('meta.bin');
      file = await fh.getFile();
    } catch {
      try {
        const fh = await root.getFileHandle('meta.json');
        file = await fh.getFile();
        return JSON.parse(await file.text()); // Plain JSON (alte Daten)
      } catch { return null; }
    }
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

async function _opfsClearAll() {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root.entries()) {
      await root.removeEntry(name, { recursive: true });
    }
  } catch (e) {
    console.warn('[Storage] OPFS clearAll fehlgeschlagen:', e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// IndexedDB Fallback Implementation
// Store "pages": key = "notebookId/pageId", value = Uint8Array
// Store "meta":  key = "meta",              value = Object
// ═══════════════════════════════════════════════════════════════════════════

/**
 * IndexedDB öffnen/erstellen.
 * @returns {Promise<void>}
 */
function _openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE_PAGES)) {
        db.createObjectStore(IDB_STORE_PAGES);
      }
      if (!db.objectStoreNames.contains(IDB_STORE_META)) {
        db.createObjectStore(IDB_STORE_META);
      }
    };
    req.onsuccess = (e) => { idb = e.target.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

/**
 * IDB-Transaktion ausführen.
 * @param {string} store - Store-Name
 * @param {'readonly'|'readwrite'} mode
 * @param {function(IDBObjectStore): IDBRequest} fn - Callback mit Store
 * @returns {Promise<*>}
 */
function _idbTx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(store, mode);
    const s = tx.objectStore(store);
    const req = fn(s);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @param {string} notebookId @param {string} pageId @returns {string} */
function _pageKey(notebookId, pageId) {
  return `${notebookId}/${pageId}`;
}

/**
 * @param {string} notebookId
 * @param {string} pageId
 * @param {Uint8Array} data
 */
async function _idbSavePageData(notebookId, pageId, data) {
  await _idbTx(IDB_STORE_PAGES, 'readwrite', s => s.put(data, _pageKey(notebookId, pageId)));
}

/**
 * @param {string} notebookId
 * @param {string} pageId
 * @returns {Promise<Uint8Array|null>}
 */
async function _idbLoadPageData(notebookId, pageId) {
  const result = await _idbTx(IDB_STORE_PAGES, 'readonly', s => s.get(_pageKey(notebookId, pageId)));
  return result ?? null;
}

/**
 * @param {string} notebookId
 * @param {string} pageId
 */
async function _idbDeletePageData(notebookId, pageId) {
  await _idbTx(IDB_STORE_PAGES, 'readwrite', s => s.delete(_pageKey(notebookId, pageId)));
}

/** @param {string} notebookId */
async function _idbDeleteNotebookData(notebookId) {
  // Alle Keys mit Prefix "notebookId/" löschen
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE_PAGES, 'readwrite');
    const store = tx.objectStore(IDB_STORE_PAGES);
    const prefix = notebookId + '/';
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(); return; }
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
        cursor.delete();
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** @param {Object|Uint8Array} meta */
async function _idbSaveMeta(meta) {
  await _idbTx(IDB_STORE_META, 'readwrite', s => s.put(meta, 'meta'));
}

/** @returns {Promise<Object|null>} */
async function _idbLoadMeta() {
  const result = await _idbTx(IDB_STORE_META, 'readonly', s => s.get('meta'));
  return result ?? null;
}

async function _idbClearAll() {
  await _idbTx(IDB_STORE_PAGES, 'readwrite', s => s.clear());
  await _idbTx(IDB_STORE_META, 'readwrite', s => s.clear());
}
