// relay.js — WebSocket Relay Client
// Speichert verschlüsselte Snapshots als Backup für Offline-Peers.
// Server sieht nur Ciphertext (Base64-encoded Uint8Array).
// Nutzt den bestehenden relay/server.js mit node-put/node-get/node-remove.

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
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const wsUrl = isLocal ? `wss://${location.host}` : 'wss://notes.mike.fm-media-staging.at';
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
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const wsUrl = isLocal ? `wss://${location.host}` : 'wss://notes.mike.fm-media-staging.at';
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
 * Blob in einem bestimmten Room speichern (über die Hauptverbindung).
 * Wechselt den Room temporär und wechselt zurück.
 * @param {string} roomKey - Ziel-Room
 * @param {string} mainRoom - Haupt-Room zum Zurückwechseln
 * @param {string} id - Blob-ID
 * @param {Uint8Array} data - Verschlüsselte Daten
 */
export function putBlobToRoom(roomKey, mainRoom, id, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'join', room: roomKey }));
  ws.send(JSON.stringify({ type: 'node-put', id, data: toBase64(data) }));
  // Zurück zum Haupt-Room
  ws.send(JSON.stringify({ type: 'join', room: mainRoom }));
}

/**
 * Prüfen ob mit Relay verbunden.
 * @returns {boolean}
 */
export function isRelayConnected() {
  return ws?.readyState === WebSocket.OPEN;
}
