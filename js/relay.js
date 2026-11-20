// relay.js — WebSocket Relay Client
// Speichert verschlüsselte Snapshots als Backup für Offline-Peers
// und leitet Live-Events an alle anderen Clients im Room weiter.
// Server sieht nur Ciphertext (Base64-encoded Uint8Array).

let ws = null;
let _pendingGets = new Map();

// ─── Base64 Helpers ──────────────────────────────────────────────────────────

function toBase64(uint8) {
  const chunks = [];
  for (let i = 0; i < uint8.length; i += 8192) {
    chunks.push(String.fromCharCode(...uint8.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(''));
}

function fromBase64(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// ─── Relay URL ───────────────────────────────────────────────────────────────

/** @type {string} Gerätelokal eingestellte Relay-Adresse ('' = Standard) */
let _customRelayUrl = '';

/**
 * Standard-URL für Relay-Verbindungen.
 * Lokal: wss://${location.host}, sonst Produktions-Relay.
 * @returns {string}
 */
export function defaultRelayUrl() {
  const isLocal = typeof location !== 'undefined' &&
    (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  return isLocal ? `wss://${location.host}` : 'wss://notes.mike.fm-media-staging.at';
}

/**
 * Prüfen, ob eine Eingabe eine brauchbare Relay-Adresse ist (nur ws:// oder wss://).
 * @param {*} url
 * @returns {boolean}
 */
export function isValidRelayUrl(url) {
  if (typeof url !== 'string' || !url.trim() || /\s/.test(url.trim())) return false;
  try {
    const u = new URL(url.trim());
    return (u.protocol === 'wss:' || u.protocol === 'ws:') && !!u.hostname;
  } catch {
    return false;
  }
}

/**
 * Eigene Relay-Adresse setzen. Leer oder ungültig = Standard.
 * Wirkt auf alle danach geöffneten Verbindungen; bestehende baut der Aufrufer neu auf.
 * @param {string} url
 */
export function setRelayUrl(url) {
  _customRelayUrl = isValidRelayUrl(url) ? url.trim() : '';
}

/** @returns {string} eigene Relay-Adresse oder '' wenn der Standard gilt */
export function getCustomRelayUrl() {
  return _customRelayUrl;
}

/**
 * WebSocket-URL für Relay-Verbindungen: eigene Adresse, sonst Standard.
 * @returns {string}
 */
function relayUrl() {
  return _customRelayUrl || defaultRelayUrl();
}

// ─── Init ────────────────────────────────────────────────────────────────────

/**
 * Relay verbinden und Room beitreten.
 * Gibt beim Join alle gespeicherten Nodes zurück (Uint8Array-Werte).
 * @param {string} roomKey - Room-ID
 * @returns {Promise<Object<string, Uint8Array>|null>} Nodes oder null bei Fehler
 */
export function initRelay(roomKey) {
  return new Promise((resolve) => {
    // Alte Verbindung schließen
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    const wsUrl = relayUrl();
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      console.warn('[Relay] WebSocket nicht verfügbar');
      resolve(null);
      return;
    }

    const timeout = setTimeout(() => {
      console.warn('[Relay] Timeout');
      resolve(null);
    }, 5000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', room: roomKey }));
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'sync') {
        clearTimeout(timeout);
        // Base64-Strings zu Uint8Array dekodieren
        const nodes = {};
        for (const [key, val] of Object.entries(msg.notebooks || {})) {
          if (typeof val === 'string') {
            try { nodes[key] = fromBase64(val); } catch {}
          }
        }
        console.log('[Relay] Verbunden,', Object.keys(nodes).length, 'Blobs');
        resolve(nodes);
      }

      if (msg.type === 'node-data' && msg.id) {
        const cb = _pendingGets.get(msg.id);
        if (cb) {
          _pendingGets.delete(msg.id);
          cb(msg.data ? fromBase64(msg.data) : null);
        }
      }
    };

    ws.onclose = () => { clearTimeout(timeout); resolve(null); };
    ws.onerror = () => { clearTimeout(timeout); resolve(null); };
  });
}

// ─── Blob Operations ─────────────────────────────────────────────────────────

function _send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

/**
 * Verschlüsselten Blob speichern.
 * Nutzt node-put mit Base64-String (kein Object-Merge auf Server).
 * @param {string} id - Blob-ID (z.B. "meta", "p:nbId/pageId")
 * @param {Uint8Array} data - Verschlüsselte Daten
 */
export function putBlob(id, data) {
  _send({ type: 'node-put', id, data: toBase64(data) });
}

/**
 * Blob löschen.
 * @param {string} id
 */
export function deleteBlob(id) {
  _send({ type: 'node-remove', id });
}

/**
 * Relay reconnecten falls WebSocket geschlossen.
 * Gibt die empfangenen Nodes zurück (oder null bei Fehler).
 * @param {string} roomKey
 * @returns {Promise<Object<string, Uint8Array>|null>}
 */
export async function reconnect(roomKey) {
  if (ws?.readyState === WebSocket.OPEN) return {};
  try {
    return await initRelay(roomKey);
  } catch {
    return null;
  }
}

/**
 * Daten aus einem anderen Relay-Room holen (temporäre Verbindung).
 * Stört die Hauptverbindung nicht.
 * @param {string} roomKey - Room-ID
 * @returns {Promise<Object<string, Uint8Array>|null>}
 */
export function fetchRoom(roomKey) {
  return new Promise(resolve => {
    const wsUrl = relayUrl();
    let tempWs;
    try { tempWs = new WebSocket(wsUrl); } catch { resolve(null); return; }

    const timeout = setTimeout(() => { try { tempWs.close(); } catch {} resolve(null); }, 5000);

    tempWs.onopen = () => {
      tempWs.send(JSON.stringify({ type: 'join', room: roomKey }));
    };
    tempWs.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'sync') {
        clearTimeout(timeout);
        const nodes = {};
        for (const [key, val] of Object.entries(msg.notebooks || {})) {
          if (typeof val === 'string') {
            try { nodes[key] = fromBase64(val); } catch {}
          }
        }
        tempWs.close();
        resolve(nodes);
      }
    };
    tempWs.onclose = () => { clearTimeout(timeout); resolve(null); };
    tempWs.onerror = () => { clearTimeout(timeout); resolve(null); };
  });
}

/**
 * Mehrere Blobs in einem anderen Room speichern (temporäre Verbindung).
 * Stört die Hauptverbindung nicht.
 * @param {string} roomKey - Ziel-Room
 * @param {Array<{id: string, data: Uint8Array}>} blobs - Zu speichernde Blobs
 * @returns {Promise<void>}
 */
export function pushBlobsToRoom(roomKey, blobs) {
  return new Promise(resolve => {
    if (!blobs.length) { resolve(); return; }
    const wsUrl = relayUrl();
    let tempWs;
    try { tempWs = new WebSocket(wsUrl); } catch { resolve(); return; }

    const timeout = setTimeout(() => { try { tempWs.close(); } catch {} resolve(); }, 5000);

    tempWs.onopen = () => {
      tempWs.send(JSON.stringify({ type: 'join', room: roomKey }));
    };
    tempWs.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      // Warte auf sync-Response (= Join bestätigt, Room ist gesetzt)
      if (msg.type === 'sync') {
        for (const { id, data } of blobs) {
          tempWs.send(JSON.stringify({ type: 'node-put', id, data: toBase64(data) }));
        }
        clearTimeout(timeout);
        console.log('[Relay] Shared Room push:', blobs.length, 'Blobs →', roomKey.slice(0, 8));
        // Warten bis WebSocket-Buffer geleert ist
        setTimeout(() => { try { tempWs.close(); } catch {} resolve(); }, 500);
      }
    };
    tempWs.onerror = () => { clearTimeout(timeout); resolve(); };
    tempWs.onclose = () => { clearTimeout(timeout); resolve(); };
  });
}

/**
 * Prüfen ob mit Relay verbunden.
 * @returns {boolean}
 */
export function isRelayConnected() {
  return ws?.readyState === WebSocket.OPEN;
}

// ─── Live Channels ───────────────────────────────────────────────────────────

const _liveChannels = new Map();
const _BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

function _setChannelState(roomKey, state) {
  const ch = _liveChannels.get(roomKey);
  if (ch) ch.state = state;
}

function _nextBackoff(index) {
  return _BACKOFF_MS[Math.min(index, _BACKOFF_MS.length - 1)];
}

function _clearReconnect(roomKey) {
  const ch = _liveChannels.get(roomKey);
  if (ch?.reconnectTimer) {
    clearTimeout(ch.reconnectTimer);
    ch.reconnectTimer = null;
  }
}

function _openSocket(roomKey, ch) {
  if (ch.closing) return;
  _clearReconnect(roomKey);
  if (ch.ws) {
    try { ch.ws.close(); } catch {}
  }
  const wsUrl = relayUrl();
  let socket;
  try {
    socket = new WebSocket(wsUrl);
  } catch (e) {
    console.warn('[Relay Live] WebSocket nicht verfügbar für', roomKey.slice(0, 8));
    _scheduleReconnect(roomKey, ch);
    return;
  }
  ch.ws = socket;
  _setChannelState(roomKey, 'verbindet');

  const joinTimeout = setTimeout(() => {
    if (socket.readyState === WebSocket.OPEN) socket.close();
  }, 5000);

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'join', room: roomKey, nosync: true }));
  };

  socket.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'joined') {
      clearTimeout(joinTimeout);
      ch.backoffIndex = 0;
      ch.liveSupported = msg.live === true;
      _setChannelState(roomKey, ch.liveSupported ? 'verbunden' : 'nicht unterstützt');
      console.log('[Relay Live] Verbunden', roomKey.slice(0, 8), ch.liveSupported ? '(live)' : '(alter Server)');
      return;
    }

    if (msg.type === 'sync') {
      // Alter Server: kennt nosync nicht und schickt stattdessen sync.
      clearTimeout(joinTimeout);
      ch.liveSupported = false;
      _setChannelState(roomKey, 'nicht unterstützt');
      console.log('[Relay Live] Alter Server erkannt', roomKey.slice(0, 8));
      return;
    }

    if (msg.type === 'event' && typeof msg.data === 'string') {
      try {
        const bytes = fromBase64(msg.data);
        if (ch.onEvent) ch.onEvent(bytes, roomKey);
      } catch {}
    }
  };

  socket.onclose = () => {
    clearTimeout(joinTimeout);
    // Ein bereits ersetzter Socket darf keinen weiteren Reconnect auslösen
    if (ch.ws !== socket) return;
    _setChannelState(roomKey, 'getrennt');
    _scheduleReconnect(roomKey, ch);
  };

  socket.onerror = () => {
    clearTimeout(joinTimeout);
    if (ch.ws !== socket) return;
    _setChannelState(roomKey, 'getrennt');
    _scheduleReconnect(roomKey, ch);
  };
}

function _scheduleReconnect(roomKey, ch) {
  if (ch.closing || ch.reconnectTimer) return;
  const delay = _nextBackoff(ch.backoffIndex);
  ch.reconnectTimer = setTimeout(() => {
    ch.reconnectTimer = null;
    ch.backoffIndex = Math.min(ch.backoffIndex + 1, _BACKOFF_MS.length - 1);
    _openSocket(roomKey, ch);
  }, delay);
}

/**
 * Dauerhaften Live-Kanal für einen Room öffnen.
 * Mehrfachaufruf für denselben Room aktualisiert nur den Callback.
 * @param {string} roomKey
 * @param {(data: Uint8Array, roomKey: string) => void} onEvent
 */
export function openLiveChannel(roomKey, onEvent) {
  const existing = _liveChannels.get(roomKey);
  if (existing) {
    existing.onEvent = onEvent;
    return;
  }
  const ch = {
    ws: null,
    state: 'verbindet',
    onEvent,
    backoffIndex: 0,
    reconnectTimer: null,
    liveSupported: true,
    closing: false
  };
  _liveChannels.set(roomKey, ch);
  _openSocket(roomKey, ch);
}

/**
 * Live-Kanal für einen Room schließen (kein Reconnect mehr).
 * @param {string} roomKey
 */
export function closeLiveChannel(roomKey) {
  const ch = _liveChannels.get(roomKey);
  if (!ch) return;
  ch.closing = true;
  _clearReconnect(roomKey);
  if (ch.ws) {
    try { ch.ws.close(); } catch {}
  }
  _liveChannels.delete(roomKey);
}

/** Alle Live-Kanäle schließen. */
export function closeAllLiveChannels() {
  for (const roomKey of [..._liveChannels.keys()]) {
    closeLiveChannel(roomKey);
  }
}

/**
 * Event über den Live-Kanal eines Rooms senden.
 * @param {string} roomKey
 * @param {Uint8Array} data
 * @returns {boolean} true wenn gesendet, false wenn nicht möglich
 */
export function sendLiveEvent(roomKey, data) {
  const ch = _liveChannels.get(roomKey);
  if (!ch || !ch.liveSupported || ch.state !== 'verbunden') return false;
  if (!ch.ws || ch.ws.readyState !== WebSocket.OPEN) return false;
  const b64 = toBase64(data);
  if (b64.length > 500 * 1024) return false;
  try {
    ch.ws.send(JSON.stringify({ type: 'event', data: b64 }));
    return true;
  } catch {
    return false;
  }
}

/** Alle nicht verbundenen Live-Kanäle sofort neu verbinden. */
export function reconnectLiveChannels() {
  for (const [roomKey, ch] of _liveChannels) {
    if (ch.closing) continue;
    if (ch.state === 'verbunden') continue;
    ch.backoffIndex = 0;
    _clearReconnect(roomKey);
    _openSocket(roomKey, ch);
  }
}

/**
 * Status aller Live-Kanäle abfragen.
 * @returns {Array<{roomKey: string, state: string}>}
 */
export function liveChannelStatus() {
  return [..._liveChannels.entries()].map(([roomKey, ch]) => ({
    roomKey,
    state: ch.state
  }));
}
