// p2p-sync.js — WebRTC P2P Sync via Trystero (Nostr Signaling)
// Signaling über öffentliche Nostr-Relays — kein eigener Server nötig.
// Datentransport via WebRTC DataChannel — direkte Peer-Verbindung.
//
// Actions:
//   'stroke'     — Ein neuer Stroke (JSON-serialisiert)
//   'undo'       — Letzter Stroke gelöscht
//   'clear'      — Seite geleert
//   'full-sync'  — Alle Strokes einer Seite (bei Peer-Join)

/** @type {string} App-ID für Trystero Room-Naming */
const APP_ID = 'notizbuch-v2';

let room = null;
let _sendStroke = null;
let _sendUndo = null;
let _sendClear = null;
let _sendFullSync = null;
let _onStroke = null;
let _onUndo = null;
let _onClear = null;
let _onFullSync = null;
let _peerJoinCallback = null;
let _peerLeaveCallback = null;

/**
 * P2P-Room für ein Notebook beitreten.
 * Room-ID = roomKey (URL-Hash), damit alle Peers im selben Raum sind.
 * @param {string} roomId - Room-ID (roomKey aus URL-Hash)
 * @param {Object} callbacks
 * @param {function(Object, string): void} callbacks.onStroke - Neuer Stroke von Peer
 * @param {function(Object, string): void} callbacks.onUndo - Undo von Peer
 * @param {function(Object, string): void} callbacks.onClear - Clear von Peer
 * @param {function(Object, string): void} callbacks.onFullSync - Full-Sync Antwort von Peer
 * @param {function(string): void} callbacks.onPeerJoin - Peer beigetreten
 * @param {function(string): void} callbacks.onPeerLeave - Peer gegangen
 */
export async function initP2P(roomId, callbacks) {
  // Vorherigen Room verlassen
  if (room) {
    try { room.leave(); } catch {}
    room = null;
  }

  try {
    const { joinRoom } = await import('https://esm.sh/trystero/nostr');
    room = joinRoom({ appId: APP_ID }, roomId);
  } catch (e) {
    console.error('[P2P] Trystero import/join fehlgeschlagen:', e);
    return;
  }

  // Actions registrieren
  const [sendStroke, receiveStroke] = room.makeAction('stroke');
  const [sendUndo, receiveUndo] = room.makeAction('undo');
  const [sendClear, receiveClear] = room.makeAction('clear');
  const [sendFullSync, receiveFullSync] = room.makeAction('full-sync');

  _sendStroke = sendStroke;
  _sendUndo = sendUndo;
  _sendClear = sendClear;
  _sendFullSync = sendFullSync;

  receiveStroke((data, peerId) => {
    if (callbacks.onStroke) callbacks.onStroke(data, peerId);
  });
  receiveUndo((data, peerId) => {
    if (callbacks.onUndo) callbacks.onUndo(data, peerId);
  });
  receiveClear((data, peerId) => {
    if (callbacks.onClear) callbacks.onClear(data, peerId);
  });
  receiveFullSync((data, peerId) => {
    if (callbacks.onFullSync) callbacks.onFullSync(data, peerId);
  });

  room.onPeerJoin(peerId => {
    console.log('[P2P] Peer joined:', peerId);
    if (callbacks.onPeerJoin) callbacks.onPeerJoin(peerId);
  });
  room.onPeerLeave(peerId => {
    console.log('[P2P] Peer left:', peerId);
    if (callbacks.onPeerLeave) callbacks.onPeerLeave(peerId);
  });

  console.log('[P2P] Room beigetreten:', roomId);
}

/**
 * Neuen Stroke an alle Peers senden.
 * @param {Object} data - { pageId, stroke }
 */
export function broadcastStroke(data) {
  if (_sendStroke) {
    try { _sendStroke(data); } catch {}
  }
}

/**
 * Undo an alle Peers senden.
 * @param {Object} data - { pageId }
 */
export function broadcastUndo(data) {
  if (_sendUndo) {
    try { _sendUndo(data); } catch {}
  }
}

/**
 * Clear an alle Peers senden.
 * @param {Object} data - { pageId }
 */
export function broadcastClear(data) {
  if (_sendClear) {
    try { _sendClear(data); } catch {}
  }
}

/**
 * Full-Sync (alle Strokes einer Seite) an einen bestimmten Peer oder alle senden.
 * @param {Object} data - { pageId, strokes }
 * @param {string} [peerId] - Wenn gesetzt, nur an diesen Peer
 */
export function sendFullSync(data, peerId) {
  if (_sendFullSync) {
    try { _sendFullSync(data, peerId); } catch {}
  }
}

/**
 * Aktuellen Room verlassen.
 */
export function leaveRoom() {
  if (room) {
    try { room.leave(); } catch {}
    room = null;
    _sendStroke = null;
    _sendUndo = null;
    _sendClear = null;
    _sendFullSync = null;
  }
}
